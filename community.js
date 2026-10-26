const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const nodemailer = require('nodemailer');
const { DatabaseSync } = require('node:sqlite');
const { limit, takeAiCredit, adminLocked, recordAdminFailure, clearAdminFailures, clientIp, cleanText, inCarolinas } = require('./security');
const { stripPhotoMetadata } = require('./photometa');
const { createJobs } = require('./jobs');
const { setupImpact } = require('./impact');
const { createNotifier } = require('./notify');
const QRCode = require('qrcode');
const { requireHuman, turnstileSiteKey, isThrowawayEmail, checkPublicText, setNetworkKey, networkId } = require('./abuse');

const router = express.Router();
const scrypt = promisify(crypto.scrypt);
const GOAL = 50;
const PRIORITY_THRESHOLD = 10;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
// Endorsements from brand-new accounts are recorded right away but only count toward
// the 10/50 thresholds once the account is this old (set 0 to turn off, e.g. for a demo).
const ENDORSE_MIN_AGE_MS = Number(process.env.ENDORSE_MIN_ACCOUNT_AGE_HOURS ?? 24) * 60 * 60 * 1000;
// This many endorsements on one issue, within a day, from new accounts on the same network
// pauses automatic promotion until a coordinator reviews it.
const BURST_ENDORSEMENTS = Number(process.env.ENDORSE_BURST_LIMIT || 5);
const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;
// Distinct community flags that hide a report until a coordinator looks at it.
const FLAGS_TO_HIDE = Number(process.env.FLAGS_TO_HIDE || 3);
const DUPLICATE_RADIUS_M = 60;
const DUPLICATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ISSUE_STAGES = ['submitted', 'ai_reviewed', 'community_priority', 'sent_to_agency', 'in_progress', 'resolved'];
const db = new DatabaseSync(process.env.SQLITE_PATH || path.join(__dirname, 'sidewalk.sqlite'));
// Wait briefly instead of failing if the database is busy (for example during a backup).
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    verified_at INTEGER,
    verify_token_hash TEXT,
    verify_expires_at INTEGER,
    email_updates INTEGER NOT NULL DEFAULT 1,
    email_unsubscribe_hash TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    category_label TEXT NOT NULL,
    description TEXT NOT NULL,
    base_supporters INTEGER NOT NULL DEFAULT 0,
    distance TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    photo_data TEXT,
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    goal_notified_at INTEGER,
    status TEXT NOT NULL DEFAULT 'submitted',
    status_updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS supports (
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (issue_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS issue_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issue_subscriptions (
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (issue_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS email_unsubscribe_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issue_photos (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS issue_photos_issue_idx ON issue_photos(issue_id, position);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS supports_issue_idx ON supports(issue_id);
  CREATE INDEX IF NOT EXISTS issue_events_issue_idx ON issue_events(issue_id, created_at);
`);

const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
if (!userColumns.has('email_unsubscribe_hash')) db.exec('ALTER TABLE users ADD COLUMN email_unsubscribe_hash TEXT');
if (!userColumns.has('reset_token_hash')) db.exec('ALTER TABLE users ADD COLUMN reset_token_hash TEXT');
if (!userColumns.has('reset_expires_at')) db.exec('ALTER TABLE users ADD COLUMN reset_expires_at INTEGER');
const issueColumns = new Set(db.prepare('PRAGMA table_info(issues)').all().map((column) => column.name));
if (!issueColumns.has('status')) db.exec("ALTER TABLE issues ADD COLUMN status TEXT NOT NULL DEFAULT 'submitted'");
if (!issueColumns.has('status_updated_at')) db.exec('ALTER TABLE issues ADD COLUMN status_updated_at INTEGER');
// Moderation and anti-abuse columns (added in place so existing data is kept).
if (!userColumns.has('suspended_at')) db.exec('ALTER TABLE users ADD COLUMN suspended_at INTEGER');
if (!issueColumns.has('hidden_at')) db.exec('ALTER TABLE issues ADD COLUMN hidden_at INTEGER');
if (!issueColumns.has('hidden_reason')) db.exec('ALTER TABLE issues ADD COLUMN hidden_reason TEXT');
if (!issueColumns.has('needs_review')) db.exec('ALTER TABLE issues ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0');
if (!issueColumns.has('review_reason')) db.exec('ALTER TABLE issues ADD COLUMN review_reason TEXT');
if (!issueColumns.has('reporter_network')) db.exec('ALTER TABLE issues ADD COLUMN reporter_network TEXT');
const supportColumns = new Set(db.prepare('PRAGMA table_info(supports)').all().map((column) => column.name));
if (!supportColumns.has('network')) db.exec('ALTER TABLE supports ADD COLUMN network TEXT');
db.exec(`
  CREATE TABLE IF NOT EXISTS issue_flags (
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (issue_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS blocked_networks (
    network TEXT PRIMARY KEY,
    reason TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS supports_network_idx ON supports(issue_id, network, created_at);
`);
// A random secret, created once, used to fingerprint networks without storing IP addresses.
let storedNetworkKey = db.prepare("SELECT value FROM app_settings WHERE key = 'network_key'").get()?.value;
if (!storedNetworkKey) {
  storedNetworkKey = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('network_key', ?)").run(storedNetworkKey);
}
setNetworkKey(storedNetworkKey);

// ---------- Roles ----------
// Everyone starts as a resident. Staff roles unlock tools; captain and teacher are reserved
// for upcoming community features.
const ROLES = ['resident', 'captain', 'teacher', 'city_staff', 'coordinator', 'admin'];
const ROLE_LABELS = { resident: 'Resident', captain: 'Block captain', teacher: 'Teacher', city_staff: 'City staff', coordinator: 'Coordinator', admin: 'Admin' };
const CAPABILITIES = {
  update_status: ['city_staff', 'coordinator', 'admin'],
  moderate: ['coordinator', 'admin'],
  assign_roles: ['admin'],
};
if (!userColumns.has('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'resident'");
// Closing the loop: who's handling a report, after photos, and follow-up reminders.
if (!issueColumns.has('assigned_to')) db.exec('ALTER TABLE issues ADD COLUMN assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL');
if (!issueColumns.has('followup_notified_at')) db.exec('ALTER TABLE issues ADD COLUMN followup_notified_at INTEGER');
const photoColumns = new Set(db.prepare('PRAGMA table_info(issue_photos)').all().map((column) => column.name));
if (!photoColumns.has('kind')) db.exec("ALTER TABLE issue_photos ADD COLUMN kind TEXT NOT NULL DEFAULT 'before'");
// A report sent to the city with no update for this long is "stale": followers get a nudge.
const STALE_MS = 21 * 24 * 60 * 60 * 1000;
const STALE_STAGES = ['sent_to_agency', 'in_progress'];
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS activity_at_idx ON activity_log(at);
`);

function userCan(user, capability) {
  return Boolean(user && CAPABILITIES[capability]?.includes(user.role));
}


const seedIssues = [
  ['crosswalk', 'Crosswalk needs a fresh coat', 'safety', 'Street safety', 'The paint has almost disappeared at the school crossing on Maple and 4th.', 38, 'Charlotte, NC', 35.2271, -80.8431],
  ['ramp', 'Missing curb ramp at the corner', 'access', 'Accessibility', 'Wheelchairs and strollers have to enter the road to get around this corner.', 24, 'Raleigh, NC', 35.7796, -78.6382],
  ['lights', 'Two streetlights out on Pine', 'lighting', 'Street lighting', 'The block between 6th and 8th gets very dark after sunset.', 49, 'Columbia, SC', 34.0007, -81.0348],
  ['park', 'A bin for the pocket park', 'parks', 'Parks & public space', 'Neighbors keep the park tidy, but there is nowhere to put the litter.', 19, 'Greenville, SC', 34.8526, -82.394],
];
const seedIssue = db.prepare(`INSERT OR IGNORE INTO issues
  (id, title, category, category_label, description, base_supporters, distance, lat, lng, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const issue of seedIssues) seedIssue.run(...issue, Date.now());
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
for (const [issueId, title, , , , baseSupporters] of seedIssues) {
  const row = db.prepare('SELECT status, created_at FROM issues WHERE id = ?').get(issueId);
  if (baseSupporters >= PRIORITY_THRESHOLD && row.status === 'submitted') {
    db.prepare('UPDATE issues SET status = ?, status_updated_at = ? WHERE id = ?').run('community_priority', Date.now(), issueId);
  }
  const eventCount = db.prepare('SELECT COUNT(*) AS total FROM issue_events WHERE issue_id = ?').get(issueId).total;
  if (!eventCount) {
    const status = db.prepare('SELECT status FROM issues WHERE id = ?').get(issueId).status;
    db.prepare('INSERT INTO issue_events (issue_id, status, note, created_at) VALUES (?, ?, ?, ?)')
      .run(issueId, 'submitted', 'Issue added to the community map.', row.created_at);
    if (status === 'community_priority') {
      db.prepare('INSERT INTO issue_events (issue_id, status, note, created_at) VALUES (?, ?, ?, ?)')
        .run(issueId, status, `Reached the ${PRIORITY_THRESHOLD}-endorsement community priority threshold.`, Date.now());
    }
  }
}
db.exec(`INSERT INTO issue_events (issue_id, status, note, created_at)
  SELECT issues.id, 'submitted', 'Issue added to the community map.', issues.created_at
  FROM issues
  WHERE NOT EXISTS (SELECT 1 FROM issue_events WHERE issue_events.issue_id = issues.id)`);

const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 2.5 * 1024 * 1024;
const PHOTO_SIGNATURES = {
  'image/jpeg': (buf) => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  'image/png': (buf) => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (buf) => buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP',
};

// Turns a data URL into a checked image buffer, or throws a message the user can act on.
function decodePhoto(dataUrl) {
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Photos must be JPEG, PNG, or WebP images.');
  const [, mime, base64] = match;
  if (base64.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4) throw new Error('Each photo must be smaller than 2.5 MB.');
  const data = Buffer.from(base64, 'base64');
  if (!data.length || data.length > MAX_PHOTO_BYTES) throw new Error('Each photo must be smaller than 2.5 MB.');
  if (!PHOTO_SIGNATURES[mime](data)) throw new Error('One of the photos is not a valid image file.');
  try {
    // Never keep hidden location or camera data, even if the browser didn't remove it.
    return { mime, data: stripPhotoMetadata(mime, data) };
  } catch (error) {
    throw new Error('One of the photos is not a valid image file.');
  }
}

const insertPhoto = db.prepare('INSERT INTO issue_photos (id, issue_id, mime, data, position, created_at) VALUES (?, ?, ?, ?, ?, ?)');

// One-time cleanup: remove hidden metadata from photos uploaded before this was added.
if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'photos_metadata_stripped'").get()) {
  const update = db.prepare('UPDATE issue_photos SET data = ? WHERE id = ?');
  for (const photo of db.prepare('SELECT id, mime, data FROM issue_photos').all()) {
    try { update.run(stripPhotoMetadata(photo.mime, Buffer.from(photo.data)), photo.id); } catch (error) { /* leave as is */ }
  }
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('photos_metadata_stripped', '1')").run();
}

// Older databases kept a single photo as a data URL on the issue row; move it into issue_photos.
for (const row of db.prepare(`SELECT id, photo_data, created_at FROM issues
  WHERE photo_data IS NOT NULL AND NOT EXISTS (SELECT 1 FROM issue_photos WHERE issue_photos.issue_id = issues.id)`).all()) {
  try {
    const { mime, data } = decodePhoto(row.photo_data);
    insertPhoto.run(crypto.randomUUID(), row.id, mime, data, 0, row.created_at);
    db.prepare('UPDATE issues SET photo_data = NULL WHERE id = ?').run(row.id);
  } catch (error) {
    console.error(`Skipped legacy photo for issue ${row.id}:`, error.message);
  }
}

const hasBrevo = Boolean(process.env.BREVO_API_KEY && process.env.SMTP_FROM);
const hasSmtp = hasBrevo || Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
const authAttempts = new Map();
const smtpTransport = !hasBrevo && hasSmtp ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER && process.env.SMTP_PASS
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
}) : null;

// Brevo sends over HTTPS, which works on hosts that block SMTP ports (e.g. Railway Hobby).
function parseFrom(from) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  return match ? { name: match[1] || 'Sidewalk', email: match[2] } : { name: 'Sidewalk', email: (from || '').trim() };
}

async function sendWithBrevo({ to, subject, text }) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: parseFrom(process.env.SMTP_FROM), to: [{ email: to }], subject, textContent: text }),
  });
  if (!response.ok) throw new Error(`Brevo email failed (${response.status}): ${await response.text()}`);
  return response.json();
}

const mailer = hasBrevo ? { sendMail: sendWithBrevo } : smtpTransport;

const jobs = createJobs(db);
// Census tract, income, and nearby fatal crashes for each report (see impact.js).
const impact = setupImpact({ db, jobs, router });
const notifier = createNotifier({ db, jobs, sendEmail: (m) => sendEmail(m), emailReady: () => Boolean(mailer), hashToken: (t) => hashToken(t), appUrl: () => appUrl(), crypto });

function sendEmail(message) {
  if (!mailer) throw new Error('Email is not configured. Add BREVO_API_KEY or SMTP_HOST, plus SMTP_FROM, to .env.');
  return mailer.sendMail({ from: process.env.SMTP_FROM, ...message });
}

function rateLimit(maxAttempts, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip || req.socket.remoteAddress}:${req.path}`;
    let attempt = authAttempts.get(key);
    if (!attempt || attempt.expiresAt <= now) attempt = { count: 0, expiresAt: now + windowMs };
    attempt.count += 1;
    authAttempts.set(key, attempt);
    if (authAttempts.size > 5000) {
      for (const [attemptKey, value] of authAttempts) if (value.expiresAt <= now) authAttempts.delete(attemptKey);
    }
    if (attempt.count > maxAttempts) {
      res.setHeader('Retry-After', String(Math.ceil((attempt.expiresAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please wait a bit and try again.' });
    }
    next();
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  const [salt, storedHex] = encoded.split(':');
  if (!salt || !storedHex) return false;
  const stored = Buffer.from(storedHex, 'hex');
  const candidate = await scrypt(password, salt, stored.length);
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

function userFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const token = cookie.match(/(?:^|;\s*)sidewalk_session=([a-f0-9]+)/)?.[1];
  if (!token) return null;
  return db.prepare(`SELECT users.id, users.name, users.email, users.email_updates, users.role
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.verified_at IS NOT NULL AND users.suspended_at IS NULL`)
    .get(hashToken(token), Date.now()) || null;
}

function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_TTL;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, expires);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sidewalk_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}`);
}

function clearSession(req, res) {
  const token = (req.headers.cookie || '').match(/(?:^|;\s*)sidewalk_session=([a-f0-9]+)/)?.[1];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sidewalk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function requireVerifiedUser(req, res, next) {
  req.user = userFromRequest(req);
  if (!req.user) return res.status(401).json({ error: 'Sign in with a verified account to continue.' });
  next();
}

function isCoordinator(req) {
  const expectedToken = process.env.ADMIN_TOKEN;
  const suppliedToken = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!expectedToken || !suppliedToken) return false;
  const expected = Buffer.from(expectedToken);
  const supplied = Buffer.from(suppliedToken);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

const STATUS_WORDS = { ai_reviewed: 'reviewed for clarity', community_priority: 'a neighborhood priority', sent_to_agency: 'sent to the city', in_progress: 'in progress', resolved: 'fixed' };

function notifyStatusChange(issue, status, note) {
  const followers = db.prepare('SELECT user_id FROM issue_subscriptions WHERE issue_id = ?').all(issue.id).map((row) => row.user_id);
  // Everyone who backed it hears when it's fixed, not just followers.
  const backers = status === 'resolved' ? db.prepare('SELECT user_id FROM supports WHERE issue_id = ?').all(issue.id).map((row) => row.user_id) : [];
  const words = STATUS_WORDS[status] || status.replaceAll('_', ' ');
  notifier.notify({
    userIds: [issue.created_by, ...followers, ...backers],
    subject: status === 'resolved' ? `Fixed: ${issue.title}` : `Sidewalk update: ${issue.title}`,
    text: status === 'resolved'
      ? `Good news: an issue you supported has been fixed.\n\n${issue.title}\n${issue.distance}\n${note}\n\nThanks for speaking up.`
      : `An issue you follow is now ${words}.\n\n${issue.title}\n${issue.distance}\n${note}`,
    title: status === 'resolved' ? 'Fixed!' : `Now ${words}`,
    body: issue.title,
    path: `/r/${issue.id}`,
  });
}

async function transitionIssue(issue, status, note) {
  const now = Date.now();
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 240) : `Status updated to ${status.replaceAll('_', ' ')}.`;
  db.prepare('UPDATE issues SET status = ?, status_updated_at = ?, followup_notified_at = NULL WHERE id = ?').run(status, now, issue.id);
  db.prepare('INSERT INTO issue_events (issue_id, status, note, created_at) VALUES (?, ?, ?, ?)')
    .run(issue.id, status, cleanNote, now);
  notifyStatusChange(issue, status, cleanNote);
  return { ...issue, status, status_updated_at: now };
}

async function reviewIssueWithAi(issueId, ai) {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
  if (!issue || issue.status !== 'submitted') return;
  if (takeAiCredit(null)) return; // Site-wide AI cap reached; skip the automatic review.
  try {
    const review = await ai.generateJson({
      system: 'Review a resident report for clarity and civic routing. Do not claim the reported condition is true or verified on site. Never invent laws or safety facts. Return only a concise completeness note and suggested urgency.',
      schema: {
        type: 'object',
        properties: {
          urgency: { type: 'string', enum: ['Routine', 'Elevated', 'Urgent'] },
          summary: { type: 'string' },
        },
        required: ['urgency', 'summary'],
      },
      prompt: `Issue category: ${issue.category_label}\nLocation: ${issue.distance}\nTitle: ${issue.title}\nDescription: ${issue.description}`,
    });
    if (!['Routine', 'Elevated', 'Urgent'].includes(review.urgency) || typeof review.summary !== 'string') return;
    const latestIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    if (!latestIssue || latestIssue.status !== 'submitted') return;
    await transitionIssue(latestIssue, 'ai_reviewed', `AI reviewed report text. Suggested urgency: ${review.urgency}. ${review.summary} This is not an on-site verification.`);
  } catch (error) {
    console.error('AI issue review failed:', error.message);
  }
}

function metersBetween(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Endorsements that count toward thresholds, and ones still waiting on account age.
function supportCounts(issueId) {
  const row = db.prepare(`SELECT
      SUM(CASE WHEN users.created_at <= ? THEN 1 ELSE 0 END) AS counted,
      SUM(CASE WHEN users.created_at > ? THEN 1 ELSE 0 END) AS pending
    FROM supports JOIN users ON users.id = supports.user_id
    WHERE supports.issue_id = ? AND users.suspended_at IS NULL`).get(Date.now() - ENDORSE_MIN_AGE_MS, Date.now() - ENDORSE_MIN_AGE_MS, issueId);
  return { counted: row.counted || 0, pending: row.pending || 0 };
}

function endorsementTotal(issue) {
  return issue.base_supporters + supportCounts(issue.id).counted;
}

function notifyGoalReached(issue) {
  const supporters = db.prepare('SELECT user_id FROM supports WHERE issue_id = ?').all(issue.id).map((row) => row.user_id);
  notifier.notify({
    userIds: supporters,
    subject: `Council-ready: ${issue.title}`,
    text: `An issue you backed reached ${GOAL} neighbors and is ready to bring to city council.\n\n${issue.title}\n${issue.description}`,
    title: `${GOAL} neighbors are in!`,
    body: `${issue.title} is council-ready.`,
    path: `/r/${issue.id}`,
  });
}

// Applies the 10 (priority) and 50 (goal) thresholds. Paused while an issue is under review.
async function evaluateThresholds(issueId) {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
  if (!issue || issue.hidden_at || issue.needs_review) return { count: issue ? endorsementTotal(issue) : 0, priorityReached: false, goalReached: false };
  const count = endorsementTotal(issue);
  let priorityReached = false;
  let goalReached = false;
  if (count >= PRIORITY_THRESHOLD && ['submitted', 'ai_reviewed'].includes(issue.status)) {
    await transitionIssue(issue, 'community_priority', `Reached the ${PRIORITY_THRESHOLD}-endorsement community priority threshold.`);
    priorityReached = true;
  }
  if (count >= GOAL && !issue.goal_notified_at) {
    const claimed = db.prepare('UPDATE issues SET goal_notified_at = ? WHERE id = ? AND goal_notified_at IS NULL').run(Date.now(), issue.id);
    if (claimed.changes) {
      goalReached = true;
      notifyGoalReached(issue);
    }
  }
  return { count, priorityReached, goalReached };
}

// Endorsements from new accounts start counting once they're old enough, so re-check
// open issues every few minutes.
jobs.every('thresholds', 10 * 60 * 1000, async () => {
  const open = db.prepare(`SELECT id FROM issues WHERE hidden_at IS NULL AND needs_review = 0
    AND (status IN ('submitted', 'ai_reviewed') OR goal_notified_at IS NULL)`).all();
  for (const { id } of open) {
    try { await evaluateThresholds(id); } catch (error) { console.error('Threshold check failed:', error.message); }
  }
});

// Reports sent to the city with no update in 3 weeks: nudge followers once per quiet stretch.
jobs.every('stale-followups', 6 * 60 * 60 * 1000, () => checkStaleReports());
function checkStaleReports() {
  const rows = db.prepare(`SELECT * FROM issues WHERE hidden_at IS NULL AND status IN ('sent_to_agency', 'in_progress')
    AND COALESCE(status_updated_at, created_at) < ? AND followup_notified_at IS NULL`).all(Date.now() - STALE_MS);
  for (const row of rows) {
    const followers = db.prepare('SELECT user_id FROM issue_subscriptions WHERE issue_id = ?').all(row.id).map((r) => r.user_id);
    const days = Math.floor((Date.now() - (row.status_updated_at || row.created_at)) / 86400000);
    notifier.notify({
      userIds: [row.created_by, ...followers],
      subject: `No update in ${days} days: ${row.title}`,
      text: `It's been ${days} days since the last update on a report you follow.\n\n${row.title}\n${row.distance}\n\nCony can help you write a short, polite follow-up to the city. Open the report and tap "Draft a follow-up".`,
      title: `No update in ${days} days`,
      body: `${row.title}: Cony can help you follow up.`,
      path: `/r/${row.id}`,
    });
    db.prepare('UPDATE issues SET followup_notified_at = ? WHERE id = ?').run(Date.now(), row.id);
  }
  return rows.length;
}

// Hourly housekeeping: expired sign-ins and old one-time email links.
jobs.every('cleanup', 60 * 60 * 1000, () => {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  db.prepare('DELETE FROM email_unsubscribe_tokens WHERE created_at < ?').run(Date.now() - 180 * 24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM activity_log WHERE at < ?').run(Date.now() - 365 * 24 * 60 * 60 * 1000);
});

// Flags an issue for coordinator review if one network sends a burst of endorsements
// from new accounts.
function checkEndorsementBurst(issueId, network) {
  if (!network) return false;
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const burst = db.prepare(`SELECT COUNT(*) AS total FROM supports JOIN users ON users.id = supports.user_id
    WHERE supports.issue_id = ? AND supports.network = ? AND supports.created_at > ? AND users.created_at > ?`)
    .get(issueId, network, since, Date.now() - NEW_ACCOUNT_MS).total;
  if (burst < BURST_ENDORSEMENTS) return false;
  const changed = db.prepare("UPDATE issues SET needs_review = 1, review_reason = ? WHERE id = ? AND needs_review = 0")
    .run(`${burst} endorsements in a day from new accounts on one network`, issueId);
  if (changed.changes) console.warn(`Issue ${issueId} flagged for review: endorsement burst from one network (${burst}).`);
  return true;
}

function isBlockedNetwork(network) {
  return Boolean(network && db.prepare('SELECT 1 FROM blocked_networks WHERE network = ?').get(network));
}

function serializeIssue(row, userId) {
  const { counted: signed, pending } = supportCounts(row.id);
  const userSupported = userId
    ? Boolean(db.prepare('SELECT 1 FROM supports WHERE issue_id = ? AND user_id = ?').get(row.id, userId))
    : false;
  const isSubscribed = userId
    ? Boolean(db.prepare('SELECT 1 FROM issue_subscriptions WHERE issue_id = ? AND user_id = ?').get(row.id, userId))
    : false;
  const events = db.prepare('SELECT status, note, created_at AS createdAt FROM issue_events WHERE issue_id = ? ORDER BY created_at ASC, id ASC').all(row.id);
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    categoryLabel: row.category_label,
    description: row.description,
    supporters: row.base_supporters + signed,
    pendingSupporters: pending,
    underReview: Boolean(row.needs_review),
    userFlagged: userId ? Boolean(db.prepare('SELECT 1 FROM issue_flags WHERE issue_id = ? AND user_id = ?').get(row.id, userId)) : false,
    distance: row.distance,
    lat: row.lat,
    lng: row.lng,
    photos: db.prepare("SELECT id FROM issue_photos WHERE issue_id = ? AND kind = 'before' ORDER BY position ASC, created_at ASC").all(row.id)
      .map((photo) => `/api/photos/${photo.id}`),
    afterPhotos: db.prepare("SELECT id FROM issue_photos WHERE issue_id = ? AND kind = 'after' ORDER BY position ASC, created_at ASC").all(row.id)
      .map((photo) => `/api/photos/${photo.id}`),
    stale: STALE_STAGES.includes(row.status) && Date.now() - (row.status_updated_at || row.created_at) > STALE_MS,
    daysSinceUpdate: Math.floor((Date.now() - (row.status_updated_at || row.created_at)) / 86400000),
    safety: impact.safetyFor(row),
    createdAt: row.created_at,
    userSupported,
    isSubscribed,
    status: row.status || 'submitted',
    statusUpdatedAt: row.status_updated_at || row.created_at,
    events,
  };
}

router.use((req, res, next) => {
  req.user = userFromRequest(req);
  next();
});

const MIN_PASSWORD = 8;
const VERIFY_TTL = 24 * 60 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;
// Used so a login for an unknown email takes as long as a real password check.
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

function appUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
}

function publicUser(user) {
  const role = user.role || 'resident';
  const can = Object.keys(CAPABILITIES).filter((cap) => CAPABILITIES[cap].includes(role));
  return { id: user.id, name: user.name, email: user.email, emailUpdates: Boolean(user.email_updates), role, roleLabel: ROLE_LABELS[role], can, push: notifier.hasPush(user.id) };
}

function cleanEmailFrom(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD && password.length <= 200;
}

async function sendVerificationEmail(user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE users SET verify_token_hash = ?, verify_expires_at = ? WHERE id = ?')
    .run(hashToken(token), Date.now() + VERIFY_TTL, user.id);
  await sendEmail({
    to: user.email,
    subject: 'Verify your Sidewalk account',
    text: `Hi ${user.name},\n\nConfirm your email to finish setting up Sidewalk (this link works for 24 hours):\n${appUrl()}/api/auth/verify?token=${token}\n\nIf you didn't create this account, you can ignore this email.`,
  });
}

router.get('/auth/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null, emailConfigured: hasSmtp, turnstileSiteKey: turnstileSiteKey() });
});

const accountsPerNetwork = limit({ name: 'signup-day', max: Number(process.env.SIGNUPS_PER_NETWORK_PER_DAY || 10), windowMs: 24 * 60 * 60 * 1000, successOnly: true, message: 'Too many new accounts from your network today. Please try again tomorrow.' });

router.post('/auth/register', rateLimit(8, 60 * 60 * 1000), accountsPerNetwork, requireHuman(), async (req, res) => {
  const { name, password, emailUpdates } = req.body || {};
  const cleanName = cleanText(name);
  const cleanEmail = cleanEmailFrom(req.body?.email);
  if (cleanName.length < 2 || cleanName.length > 60) return res.status(400).json({ error: 'Enter a name between 2 and 60 characters.', field: 'name' });
  if (!validEmail(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address.', field: 'email' });
  if (checkPublicText(cleanName)) return res.status(400).json({ error: 'Choose a different display name.', field: 'name' });
  if (isThrowawayEmail(cleanEmail)) return res.status(400).json({ error: 'Temporary or throwaway email addresses can’t be used. Use your regular email.', field: 'email' });
  if (isBlockedNetwork(networkId(clientIp(req)))) return res.status(403).json({ error: 'New accounts can’t be created from this network.' });
  if (!validPassword(password)) return res.status(400).json({ error: `Use a password with at least ${MIN_PASSWORD} characters.`, field: 'password' });
  if (!mailer && process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'Sign-up is paused until email is configured on the server.' });

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  if (existing?.verified_at) return res.status(409).json({ error: 'An account already uses this email. Sign in instead, or reset your password.', field: 'email', suggest: 'login' });

  const passwordHash = await hashPassword(password);
  const wantsUpdates = hasSmtp && emailUpdates !== false ? 1 : 0;
  let user;
  if (existing) {
    // Someone signed up but never verified: let them try again instead of locking the email forever.
    db.prepare('UPDATE users SET name = ?, password_hash = ?, email_updates = ? WHERE id = ?').run(cleanName, passwordHash, wantsUpdates, existing.id);
    user = { ...existing, name: cleanName, email_updates: wantsUpdates };
  } else {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO users (id, name, email, password_hash, email_updates, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, cleanName, cleanEmail, passwordHash, wantsUpdates, Date.now());
    user = { id, name: cleanName, email: cleanEmail, email_updates: wantsUpdates };
  }

  if (mailer) {
    try {
      await sendVerificationEmail(user);
    } catch (error) {
      console.error('Verification email failed:', error.message);
      if (!existing) db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      return res.status(502).json({ error: 'We couldn’t send the verification email. Check the address and try again.' });
    }
    return res.status(201).json({ pendingVerification: true, email: cleanEmail, message: `We sent a verification link to ${cleanEmail}. Open it to finish signing up.`, emailConfigured: true });
  }

  // Local development without SMTP: verify immediately so the app is usable.
  db.prepare('UPDATE users SET verified_at = ?, verify_token_hash = NULL, verify_expires_at = NULL WHERE id = ?').run(Date.now(), user.id);
  setSession(res, user.id);
  res.status(201).json({ user: publicUser({ ...user, email_updates: 0 }), message: `Welcome, ${cleanName}. You're signed in.`, emailConfigured: false });
});

router.post('/auth/resend-verification', rateLimit(5, 60 * 60 * 1000), async (req, res) => {
  const email = cleanEmailFrom(req.body?.email);
  const generic = { message: 'If that account is waiting for verification, a new link is on its way.' };
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.', field: 'email' });
  if (!mailer) return res.status(503).json({ error: 'Email isn’t configured on this server, so links can’t be sent.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND verified_at IS NULL').get(email);
  if (user) {
    try { await sendVerificationEmail(user); } catch (error) { console.error('Resend verification failed:', error.message); }
  }
  res.json(generic);
});

router.get('/auth/verify', limit({ name: 'verify', max: 30, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const user = token ? db.prepare('SELECT id FROM users WHERE verify_token_hash = ? AND verify_expires_at > ?').get(hashToken(token), Date.now()) : null;
  if (!user) return res.redirect('/?verified=expired');
  db.prepare('UPDATE users SET verified_at = ?, verify_token_hash = NULL, verify_expires_at = NULL WHERE id = ?').run(Date.now(), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  setSession(res, user.id);
  res.redirect('/?verified=1');
});

router.post('/auth/login', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  const email = cleanEmailFrom(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const passwordOk = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
  if (!user || !passwordOk) return res.status(401).json({ error: 'That email and password don’t match. Check them, or reset your password.' });
  if (user.suspended_at) return res.status(403).json({ error: 'This account has been suspended for breaking Sidewalk’s community guidelines.' });
  if (!user.verified_at) {
    if (!mailer && process.env.NODE_ENV !== 'production') {
      db.prepare('UPDATE users SET verified_at = ?, verify_token_hash = NULL, verify_expires_at = NULL, email_updates = 0 WHERE id = ?').run(Date.now(), user.id);
      user.email_updates = 0;
    } else {
      return res.status(403).json({ error: 'Confirm your email first. Open the verification link we sent, or send a new one.', needsVerification: true, email: user.email });
    }
  }
  setSession(res, user.id);
  res.json({ user: publicUser(user), emailConfigured: hasSmtp });
});

router.post('/auth/forgot-password', rateLimit(5, 60 * 60 * 1000), requireHuman(), async (req, res) => {
  const email = cleanEmailFrom(req.body?.email);
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.', field: 'email' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const response = { message: `If an account uses ${email}, a reset link is on its way. It works for one hour.` };
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE users SET reset_token_hash = ?, reset_expires_at = ? WHERE id = ?').run(hashToken(token), Date.now() + RESET_TTL, user.id);
    const resetUrl = `${appUrl()}/?reset=${token}`;
    if (mailer) {
      try {
        await sendEmail({
          to: user.email,
          subject: 'Reset your Sidewalk password',
          text: `Hi ${user.name},\n\nUse this link to choose a new password (it works for one hour):\n${resetUrl}\n\nIf you didn't ask for this, you can ignore this email; your password hasn't changed.`,
        });
      } catch (error) {
        console.error('Reset email failed:', error.message);
      }
    } else if (process.env.NODE_ENV !== 'production') {
      // No SMTP in local development: hand the link back so the flow can still be tested.
      console.log(`Password reset link for ${user.email}: ${resetUrl}`);
      response.devResetUrl = resetUrl;
    }
  }
  if (!mailer && process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'Password reset needs email, which isn’t configured on this server.' });
  res.json(response);
});

router.post('/auth/reset-password', rateLimit(10, 60 * 60 * 1000), async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const password = req.body?.password;
  if (!validPassword(password)) return res.status(400).json({ error: `Use a password with at least ${MIN_PASSWORD} characters.`, field: 'password' });
  const user = token ? db.prepare('SELECT * FROM users WHERE reset_token_hash = ? AND reset_expires_at > ?').get(hashToken(token), Date.now()) : null;
  if (!user) return res.status(400).json({ error: 'This reset link has expired or was already used. Request a new one.' });
  const passwordHash = await hashPassword(password);
  // Following a reset link proves the person controls the inbox, so it also verifies the account.
  db.prepare('UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_expires_at = NULL, verified_at = COALESCE(verified_at, ?), verify_token_hash = NULL WHERE id = ?')
    .run(passwordHash, Date.now(), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  setSession(res, user.id);
  res.json({ user: publicUser(user), message: 'Password updated. You’re signed in.', emailConfigured: hasSmtp });
});

// ---------- Your data ----------
router.get('/auth/export', requireVerifiedUser, limit({ name: 'export', max: 10, windowMs: 60 * 60 * 1000, by: 'user' }), (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, email_updates, verified_at, created_at FROM users WHERE id = ?').get(req.user.id);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const reports = db.prepare('SELECT * FROM issues WHERE created_by = ? ORDER BY created_at').all(user.id).map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category_label,
    description: row.description,
    area: row.distance,
    latitude: row.lat,
    longitude: row.lng,
    status: row.status,
    hidden: Boolean(row.hidden_at),
    postedAt: iso(row.created_at),
    photos: db.prepare('SELECT id, kind FROM issue_photos WHERE issue_id = ? ORDER BY kind, position').all(row.id).map((photo) => ({ kind: photo.kind, url: `${appUrl()}/api/photos/${photo.id}` })),
  }));
  const titled = (sql) => db.prepare(sql).all(user.id).map((row) => ({ ...row, at: iso(row.at) }));
  const data = {
    exportedAt: new Date().toISOString(),
    about: 'Everything Sidewalk stores that is linked to your account. Passwords are stored only as a one-way hash and are not included.',
    account: { name: user.name, email: user.email, role: user.role, emailUpdates: Boolean(user.email_updates), phoneNotificationDevices: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(user.id).n, createdAt: iso(user.created_at), verifiedAt: iso(user.verified_at) },
    reports,
    endorsements: titled('SELECT issues.id AS issueId, issues.title, supports.created_at AS at FROM supports JOIN issues ON issues.id = supports.issue_id WHERE supports.user_id = ? ORDER BY supports.created_at'),
    following: titled('SELECT issues.id AS issueId, issues.title, issue_subscriptions.created_at AS at FROM issue_subscriptions JOIN issues ON issues.id = issue_subscriptions.issue_id WHERE issue_subscriptions.user_id = ? ORDER BY issue_subscriptions.created_at'),
    flags: titled('SELECT issues.id AS issueId, issues.title, issue_flags.reason, issue_flags.created_at AS at FROM issue_flags JOIN issues ON issues.id = issue_flags.issue_id WHERE issue_flags.user_id = ? ORDER BY issue_flags.created_at'),
  };
  res.setHeader('Content-Disposition', `attachment; filename="sidewalk-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/json').send(JSON.stringify(data, null, 2));
});

router.post('/auth/delete-account', requireVerifiedUser, rateLimit(5, 60 * 60 * 1000), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!(await verifyPassword(password, user.password_hash))) return res.status(401).json({ error: 'That password isn’t right.', field: 'password' });
  const keepReports = req.body?.keepReports === true;
  db.exec('BEGIN');
  try {
    if (keepReports) db.prepare('UPDATE issues SET created_by = NULL WHERE created_by = ?').run(user.id);
    else db.prepare('DELETE FROM issues WHERE created_by = ?').run(user.id);
    // Sessions, endorsements, follows, flags, and email links are removed with the account.
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(`Account deleted at the user's request (${keepReports ? 'reports kept without a name' : 'reports deleted'}).`);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sidewalk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
  res.json({ deleted: true });
});

router.post('/auth/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

router.patch('/auth/preferences', requireVerifiedUser, limit({ name: 'prefs', max: 30, windowMs: 60 * 60 * 1000, by: 'ip+user' }), (req, res) => {
  if (typeof req.body?.emailUpdates !== 'boolean') return res.status(400).json({ error: 'Choose whether to receive petition email updates.' });
  if (req.body.emailUpdates && !hasSmtp) return res.status(503).json({ error: 'Email updates cannot be enabled until SMTP is configured.' });
  db.prepare('UPDATE users SET email_updates = ? WHERE id = ?').run(req.body.emailUpdates ? 1 : 0, req.user.id);
  res.json({ emailUpdates: req.body.emailUpdates });
});

router.get('/email/unsubscribe', limit({ name: 'unsubscribe', max: 30, windowMs: 60 * 60 * 1000 }), (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return res.status(400).send('This unsubscribe link is invalid.');
  const user = db.prepare('SELECT user_id AS id FROM email_unsubscribe_tokens WHERE token_hash = ?').get(hashToken(token));
  if (!user) return res.status(400).send('This unsubscribe link is invalid or has already been used.');
  db.prepare('UPDATE users SET email_updates = 0 WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM email_unsubscribe_tokens WHERE user_id = ?').run(user.id);
  res.send('Email updates have been turned off for your Sidewalk account.');
});

router.get('/issues', (req, res) => {
  const rows = db.prepare(`SELECT issues.* FROM issues LEFT JOIN users ON users.id = issues.created_by
    WHERE issues.hidden_at IS NULL AND users.suspended_at IS NULL ORDER BY issues.created_at DESC`).all();
  res.json({
    issues: rows.map((row) => serializeIssue(row, req.user?.id)),
    priorityThreshold: PRIORITY_THRESHOLD,
    petitionGoal: GOAL,
    coordinatorConfigured: Boolean(process.env.ADMIN_TOKEN),
  });
});

router.get('/photos/:id', (req, res) => {
  const photo = db.prepare(`SELECT issue_photos.mime, issue_photos.data, issues.hidden_at FROM issue_photos
    JOIN issues ON issues.id = issue_photos.issue_id WHERE issue_photos.id = ?`).get(req.params.id);
  if (!photo || (photo.hidden_at && !isCoordinator(req) && !userCan(req.user, 'moderate'))) return res.status(404).json({ error: 'Photo not found.' });
  res.setHeader('Content-Type', photo.mime);
  // Cached for a day (not forever) so a hidden report's photos stop showing reasonably soon.
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(photo.data));
});

router.get('/issues/:id', (req, res) => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ? AND hidden_at IS NULL').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  res.json({ issue: serializeIssue(issue, req.user?.id), priorityThreshold: PRIORITY_THRESHOLD, petitionGoal: GOAL });
});

router.post('/issues/:id/subscribe', requireVerifiedUser, limit({ name: 'follow', max: 60, windowMs: 60 * 60 * 1000, by: 'ip+user' }), (req, res) => {
  const issue = db.prepare('SELECT id FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  db.prepare('INSERT OR IGNORE INTO issue_subscriptions (issue_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(issue.id, req.user.id, Date.now());
  res.json({ subscribed: true, emailAlertsEnabled: hasSmtp && Boolean(req.user.email_updates) });
});

router.delete('/issues/:id/subscribe', requireVerifiedUser, limit({ name: 'follow', max: 60, windowMs: 60 * 60 * 1000, by: 'ip+user' }), (req, res) => {
  db.prepare('DELETE FROM issue_subscriptions WHERE issue_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ subscribed: false });
});

// Staff tools: a signed-in account with the right role, or the ADMIN_TOKEN (acts as admin).
function requireCan(capability) {
  return (req, res, next) => {
    if (userCan(req.user, capability)) {
      req.staff = { actor: `user:${req.user.id}`, name: req.user.name };
      return next();
    }
    const supplied = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!supplied) {
      return res.status(req.user ? 403 : 401).json({ error: req.user ? 'Your account doesn’t have access to this tool.' : 'Sign in with a staff account, or enter the coordinator token.' });
    }
    if (!process.env.ADMIN_TOKEN) return res.status(503).json({ error: 'The coordinator token is off on this server. Sign in with a staff account instead.' });
    if (adminLocked(req)) return res.status(429).json({ error: 'Too many wrong coordinator tokens. Coordinator tools are locked for 15 minutes on this network.' });
    if (!isCoordinator(req)) {
      recordAdminFailure(req);
      console.warn(`Coordinator token rejected from ${clientIp(req)} on ${req.method} ${req.path}`);
      return res.status(403).json({ error: 'Coordinator token is invalid.' });
    }
    clearAdminFailures(req);
    req.staff = { actor: 'token', name: 'Coordinator token' };
    next();
  };
}

function logActivity(req, action, target, detail = '') {
  db.prepare('INSERT INTO activity_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), req.staff?.actor || 'system', action, target || null, String(detail).slice(0, 300));
  console.log(`[activity] ${req.staff?.name || 'system'}: ${action} ${target || ''} ${detail}`.trim());
}

router.patch('/issues/:id/status', requireCan('update_status'), async (req, res) => {
  const { status } = req.body || {};
  const note = cleanText(req.body?.note).slice(0, 240);
  if (!ISSUE_STAGES.includes(status) || status === 'submitted') return res.status(400).json({ error: 'Choose a valid next issue status.' });
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  const endorsementCount = endorsementTotal(issue);
  const allowedNext = {
    // Staff can move a report on even if the automatic AI review hasn't happened (AI off or over its daily cap).
    submitted: endorsementCount >= PRIORITY_THRESHOLD ? ['community_priority', 'sent_to_agency'] : ['sent_to_agency'],
    ai_reviewed: endorsementCount >= PRIORITY_THRESHOLD ? ['community_priority', 'sent_to_agency'] : ['sent_to_agency'],
    community_priority: ['sent_to_agency'],
    sent_to_agency: ['in_progress'],
    in_progress: ['resolved'],
    resolved: [],
  }[issue.status || 'submitted'];
  if (!allowedNext?.includes(status)) return res.status(409).json({ error: 'This status is not the next valid lifecycle stage. Priority requires 10 endorsements.' });
  logActivity(req, 'status', issue.id, `${issue.status || 'submitted'} → ${status}`);
  try {
    const updated = await transitionIssue(issue, status, note);
    res.json({ issue: serializeIssue(db.prepare('SELECT * FROM issues WHERE id = ?').get(updated.id), req.user?.id), emailAlertsEnabled: hasSmtp });
  } catch (error) {
    console.error('Issue status updated, but notifications failed:', error.message);
    res.json({ issue: serializeIssue(db.prepare('SELECT * FROM issues WHERE id = ?').get(issue.id), req.user?.id), emailAlertsEnabled: false });
  }
});

const reportHourly = limit({ name: 'report-hour', max: 6, windowMs: 60 * 60 * 1000, by: 'ip+user', successOnly: true, message: 'You’ve posted several reports in the last hour. Please wait a bit before posting another.' });
const reportDaily = limit({ name: 'report-day', max: 20, windowMs: 24 * 60 * 60 * 1000, by: 'ip+user', successOnly: true, message: 'You’ve reached today’s limit for new reports. Please try again tomorrow.' });

router.post('/issues', reportHourly, reportDaily, requireHuman((req) => !req.user), async (req, res) => {
  const { category, lat, lng, photo } = req.body || {};
  const network = networkId(clientIp(req));
  if (isBlockedNetwork(network)) return res.status(403).json({ error: 'Reports can’t be posted from this network.' });
  const title = cleanText(req.body?.title);
  const description = cleanText(req.body?.description, { multiline: true });
  const distance = cleanText(req.body?.distance).slice(0, 100);
  const rawPhotos = Array.isArray(req.body?.photos) ? req.body.photos : (photo ? [photo] : []);
  const categories = { safety: 'Street safety', access: 'Accessibility', parks: 'Parks & public space', lighting: 'Street lighting', other: 'Neighborhood issue' };
  if (title.length < 3 || title.length > 70) return res.status(400).json({ error: 'Issue titles must be 3 to 70 characters.' });
  if (!categories[category]) return res.status(400).json({ error: 'Choose a valid issue category.' });
  if (description.length < 5 || description.length > 400) return res.status(400).json({ error: 'Issue descriptions must be 5 to 400 characters.' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Choose a valid map location.' });
  if (!inCarolinas(lat, lng)) return res.status(400).json({ error: 'Sidewalk covers North and South Carolina. Drop the pin on a spot inside the Carolinas.' });
  const textProblem = checkPublicText(`${title}\n${description}`);
  if (textProblem) return res.status(400).json({ error: textProblem });
  // Same kind of problem already reported very close by, recently? Suggest backing it instead.
  if (req.body?.confirmNotDuplicate !== true) {
    const latPad = DUPLICATE_RADIUS_M / 111000;
    const lngPad = latPad / Math.cos((lat * Math.PI) / 180);
    const nearby = db.prepare(`SELECT * FROM issues WHERE category = ? AND hidden_at IS NULL AND status != 'resolved'
      AND created_at > ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY created_at DESC`)
      .all(category, Date.now() - DUPLICATE_WINDOW_MS, lat - latPad, lat + latPad, lng - lngPad, lng + lngPad);
    const match = nearby.find((row) => metersBetween(lat, lng, row.lat, row.lng) <= DUPLICATE_RADIUS_M);
    if (match) {
      return res.status(409).json({
        error: 'Someone already reported this kind of problem right here.',
        duplicate: serializeIssue(match, req.user?.id),
      });
    }
  }
  if (rawPhotos.length > MAX_PHOTOS) return res.status(400).json({ error: `Attach up to ${MAX_PHOTOS} photos.` });
  let photos;
  try {
    photos = rawPhotos.map(decodePhoto);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  db.prepare(`INSERT INTO issues (id, title, category, category_label, description, distance, lat, lng, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, title, category, categories[category], description, distance || 'The Carolinas', lat, lng, req.user?.id || null, createdAt);
  db.prepare('UPDATE issues SET reporter_network = ? WHERE id = ?').run(network, id);
  photos.forEach(({ mime, data }, position) => insertPhoto.run(crypto.randomUUID(), id, mime, data, position, createdAt));
  db.prepare('INSERT INTO issue_events (issue_id, status, note, created_at) VALUES (?, ?, ?, ?)')
    .run(id, 'submitted', 'Issue submitted to the community map.', createdAt);
  if (req.user) db.prepare('INSERT INTO supports (issue_id, user_id, created_at, network) VALUES (?, ?, ?, ?)').run(id, req.user.id, Date.now(), network);
  if (req.user) db.prepare('INSERT OR IGNORE INTO issue_subscriptions (issue_id, user_id, created_at) VALUES (?, ?, ?)').run(id, req.user.id, createdAt);
  impact.queue(id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  res.status(201).json({ issue: serializeIssue(issue, req.user?.id) });
  if (req.app.locals.ai) setImmediate(() => reviewIssueWithAi(id, req.app.locals.ai));
});

router.post('/issues/:id/support', requireVerifiedUser, limit({ name: 'endorse', max: 30, windowMs: 60 * 60 * 1000, by: 'ip+user', message: 'You’re endorsing reports very quickly. Please wait a bit and try again.' }), async (req, res) => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ? AND hidden_at IS NULL').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  const network = networkId(clientIp(req));
  try {
    db.prepare('INSERT INTO supports (issue_id, user_id, created_at, network) VALUES (?, ?, ?, ?)').run(issue.id, req.user.id, Date.now(), network);
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'You already supported this issue.' });
    throw error;
  }
  db.prepare('INSERT OR IGNORE INTO issue_subscriptions (issue_id, user_id, created_at) VALUES (?, ?, ?)').run(issue.id, req.user.id, Date.now());
  const underReview = checkEndorsementBurst(issue.id, network);
  const { count, priorityReached, goalReached } = await evaluateThresholds(issue.id);
  const account = db.prepare('SELECT created_at FROM users WHERE id = ?').get(req.user.id);
  const pending = account.created_at > Date.now() - ENDORSE_MIN_AGE_MS;
  res.json({ count, pending, pendingSupporters: supportCounts(issue.id).pending, underReview, goalReached, priorityReached });
});

// ---------- Closing the loop ----------
// Staff add "after" photos when a report is fixed (up to 4).
router.post('/issues/:id/after-photos', requireCan('update_status'), limit({ name: 'after-photos', max: 30, windowMs: 60 * 60 * 1000, by: 'ip+user' }), (req, res) => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  const raw = Array.isArray(req.body?.photos) ? req.body.photos : [];
  const existing = db.prepare("SELECT COUNT(*) AS n FROM issue_photos WHERE issue_id = ? AND kind = 'after'").get(issue.id).n;
  if (!raw.length) return res.status(400).json({ error: 'Add at least one photo.' });
  if (existing + raw.length > MAX_PHOTOS) return res.status(400).json({ error: `A report can have up to ${MAX_PHOTOS} after photos.` });
  let photos;
  try { photos = raw.map(decodePhoto); } catch (error) { return res.status(400).json({ error: error.message }); }
  const now = Date.now();
  photos.forEach(({ mime, data }, i) => db.prepare("INSERT INTO issue_photos (id, issue_id, mime, data, position, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, 'after')")
    .run(crypto.randomUUID(), issue.id, mime, data, existing + i, now));
  logActivity(req, 'after-photos', issue.id, `${photos.length} photo(s)`);
  res.status(201).json({ issue: serializeIssue(db.prepare('SELECT * FROM issues WHERE id = ?').get(issue.id), req.user?.id) });
});

// The staff work queue: every visible report with who's on it and how long it's been quiet.
router.get('/staff/queue', requireCan('update_status'), (req, res) => {
  const rows = db.prepare(`SELECT issues.*, assignee.name AS assignee_name FROM issues
    LEFT JOIN users AS assignee ON assignee.id = issues.assigned_to
    LEFT JOIN users AS reporter ON reporter.id = issues.created_by
    WHERE issues.hidden_at IS NULL AND reporter.suspended_at IS NULL
    ORDER BY COALESCE(issues.status_updated_at, issues.created_at) ASC`).all();
  res.json({
    me: req.user ? req.user.id : null,
    items: rows.map((row) => ({ ...serializeIssue(row, req.user?.id), assignedTo: row.assigned_to, assigneeName: row.assignee_name })),
  });
});

router.post('/staff/issues/:id/assign', requireCan('update_status'), (req, res) => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  const take = req.body?.assign === true;
  if (take && !req.user) return res.status(400).json({ error: 'Sign in with your staff account to take a report.' });
  db.prepare('UPDATE issues SET assigned_to = ? WHERE id = ?').run(take ? req.user.id : null, issue.id);
  logActivity(req, take ? 'assign' : 'unassign', issue.id);
  res.json({ assignedTo: take ? req.user.id : null, assigneeName: take ? req.user.name : null });
});

// Cony drafts a polite follow-up to the city for a report that's gone quiet.
router.post('/issues/:id/follow-up-draft', requireVerifiedUser, limit({ name: 'followup-draft', max: 10, windowMs: 60 * 60 * 1000, by: 'ip+user' }), async (req, res) => {
  const ai = req.app.locals.ai;
  if (!ai) return res.status(503).json({ error: 'Cony isn’t available on this server right now.' });
  const issue = db.prepare('SELECT * FROM issues WHERE id = ? AND hidden_at IS NULL').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  const capMessage = takeAiCredit(`u${req.user.id}`);
  if (capMessage) return res.status(429).json({ error: capMessage });
  const events = db.prepare('SELECT status, note, created_at FROM issue_events WHERE issue_id = ? ORDER BY created_at').all(issue.id)
    .map((e) => `${new Date(e.created_at).toDateString()}: ${STATUS_WORDS[e.status] || e.status}. ${e.note}`).join('\n');
  try {
    const draft = await ai.generateJson({
      system: 'You are Cony, Sidewalk\'s helper. Write a short, polite follow-up email from a resident to their local public works department about an infrastructure report that has not had an update in a while. Thank them, restate the problem and location in one sentence, mention when it was reported or sent, and ask for a status update and an expected timeline. Never invent names, phone numbers, email addresses, work order numbers, laws, or deadlines; only use facts given. Plain text, under 150 words, no Markdown. Sign it "A resident" so the person can add their name.',
      schema: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] },
      prompt: `Report: ${issue.title}\nLocation: ${issue.distance}\nDescription: ${issue.description}\nNeighbors backing it: ${endorsementTotal(issue)}\nTimeline:\n${events}\nDays since last update: ${Math.floor((Date.now() - (issue.status_updated_at || issue.created_at)) / 86400000)}`,
    });
    if (!draft.subject || !draft.body) return res.status(502).json({ error: 'Cony couldn’t finish the draft. Please try again.' });
    res.json({ draft: { subject: String(draft.subject).slice(0, 200), body: String(draft.body).slice(0, 2000) } });
  } catch (error) {
    console.error('Follow-up draft failed:', error.message);
    res.status(502).json({ error: 'Cony couldn’t write a draft right now. Please try again shortly.' });
  }
});

// A QR code for the printed council packet: scan it to open and back the report.
router.get('/issues/:id/qr.svg', async (req, res) => {
  const issue = db.prepare('SELECT id FROM issues WHERE id = ? AND hidden_at IS NULL').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  const svg = await QRCode.toString(`${appUrl()}/r/${issue.id}`, { type: 'svg', margin: 1, color: { dark: '#23272b', light: '#ffffff' } });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
});

// ---------- Community flags ----------
const FLAG_REASONS = {
  spam: 'Spam or advertising',
  offensive: 'Offensive or hateful',
  fake: 'Not a real problem',
  private: 'Shows private information or people',
  duplicate: 'Duplicate of another report',
  other: 'Something else',
};

router.post('/issues/:id/flag', requireVerifiedUser, limit({ name: 'flag', max: 20, windowMs: 24 * 60 * 60 * 1000, by: 'ip+user', message: 'You’ve flagged a lot of reports today. A coordinator will review them.' }), (req, res) => {
  const reason = typeof req.body?.reason === 'string' && FLAG_REASONS[req.body.reason] ? req.body.reason : null;
  if (!reason) return res.status(400).json({ error: 'Choose a reason for flagging this report.' });
  const issue = db.prepare('SELECT * FROM issues WHERE id = ? AND hidden_at IS NULL').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  db.prepare('INSERT OR IGNORE INTO issue_flags (issue_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)').run(issue.id, req.user.id, reason, Date.now());
  const flags = db.prepare('SELECT COUNT(*) AS total FROM issue_flags WHERE issue_id = ?').get(issue.id).total;
  let hidden = false;
  if (flags >= FLAGS_TO_HIDE) {
    db.prepare('UPDATE issues SET hidden_at = ?, hidden_reason = ? WHERE id = ? AND hidden_at IS NULL')
      .run(Date.now(), `Hidden automatically after ${flags} community flags`, issue.id);
    hidden = true;
    console.warn(`Issue ${issue.id} hidden automatically after ${flags} flags.`);
  }
  res.json({ flagged: true, hidden });
});

// ---------- Coordinator moderation ----------
function moderationView(row) {
  const flags = db.prepare('SELECT reason, COUNT(*) AS total FROM issue_flags WHERE issue_id = ? GROUP BY reason ORDER BY total DESC').all(row.id);
  const reporter = row.created_by ? db.prepare('SELECT id, name, email, created_at, suspended_at FROM users WHERE id = ?').get(row.created_by) : null;
  const base = serializeIssue(row);
  return {
    ...base,
    hidden: Boolean(row.hidden_at),
    hiddenReason: row.hidden_reason,
    reviewReason: row.review_reason,
    flags: flags.map((f) => ({ reason: FLAG_REASONS[f.reason] || f.reason, total: f.total })),
    flagTotal: flags.reduce((sum, f) => sum + f.total, 0),
    reporter: reporter
      ? { id: reporter.id, name: reporter.name, email: reporter.email, joinedAt: reporter.created_at, suspended: Boolean(reporter.suspended_at) }
      : { guest: true, networkBlocked: isBlockedNetwork(row.reporter_network) },
  };
}

router.get('/admin/moderation', requireCan('moderate'), (req, res) => {
  const rows = db.prepare(`SELECT issues.* FROM issues
    WHERE issues.hidden_at IS NOT NULL OR issues.needs_review = 1
      OR EXISTS (SELECT 1 FROM issue_flags WHERE issue_flags.issue_id = issues.id)
    ORDER BY COALESCE(issues.hidden_at, issues.created_at) DESC LIMIT 100`).all();
  res.json({ items: rows.map(moderationView) });
});

router.get('/admin/issues/:id', requireCan('moderate'), (req, res) => {
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Issue not found.' });
  res.json({ item: moderationView(row) });
});

function adminIssue(req, res) {
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!row) res.status(404).json({ error: 'Issue not found.' });
  return row;
}

router.post('/admin/issues/:id/hide', requireCan('moderate'), (req, res) => {
  const row = adminIssue(req, res);
  if (!row) return;
  const reason = cleanText(req.body?.reason).slice(0, 160) || 'Hidden by a coordinator';
  db.prepare('UPDATE issues SET hidden_at = ?, hidden_reason = ? WHERE id = ?').run(Date.now(), reason, row.id);
  logActivity(req, 'hide', row.id, reason);
  res.json({ item: moderationView(db.prepare('SELECT * FROM issues WHERE id = ?').get(row.id)) });
});

router.post('/admin/issues/:id/restore', requireCan('moderate'), async (req, res) => {
  const row = adminIssue(req, res);
  if (!row) return;
  // Restoring means a coordinator looked at it: clear flags and the review hold too.
  db.prepare('UPDATE issues SET hidden_at = NULL, hidden_reason = NULL, needs_review = 0, review_reason = NULL WHERE id = ?').run(row.id);
  db.prepare('DELETE FROM issue_flags WHERE issue_id = ?').run(row.id);
  logActivity(req, 'restore', row.id);
  await evaluateThresholds(row.id);
  res.json({ item: moderationView(db.prepare('SELECT * FROM issues WHERE id = ?').get(row.id)) });
});

router.delete('/admin/issues/:id', requireCan('moderate'), (req, res) => {
  const row = adminIssue(req, res);
  if (!row) return;
  db.prepare('DELETE FROM issues WHERE id = ?').run(row.id);
  logActivity(req, 'delete', row.id, row.title);
  res.json({ deleted: true });
});

// Suspends the person who posted a report. For guest reports, blocks the network they
// posted from instead (stored only as a fingerprint, never as an IP address).
router.post('/admin/issues/:id/suspend-reporter', requireCan('moderate'), (req, res) => {
  const row = adminIssue(req, res);
  if (!row) return;
  const reason = cleanText(req.body?.reason).slice(0, 160) || 'Suspended by a coordinator';
  if (row.created_by) {
    db.prepare('UPDATE users SET suspended_at = ? WHERE id = ?').run(Date.now(), row.created_by);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.created_by);
    // Their other networks can't be used to post as a guest either.
    const networks = db.prepare(`SELECT DISTINCT network FROM supports WHERE user_id = ? AND network IS NOT NULL
      UNION SELECT DISTINCT reporter_network FROM issues WHERE created_by = ? AND reporter_network IS NOT NULL`).all(row.created_by, row.created_by);
    for (const { network } of networks) db.prepare('INSERT OR IGNORE INTO blocked_networks (network, reason, created_at) VALUES (?, ?, ?)').run(network, reason, Date.now());
    logActivity(req, 'suspend', row.id, `account ${row.created_by}`);
  } else if (row.reporter_network) {
    db.prepare('INSERT OR IGNORE INTO blocked_networks (network, reason, created_at) VALUES (?, ?, ?)').run(row.reporter_network, reason, Date.now());
    logActivity(req, 'block-network', row.id, 'guest reporter');
  } else {
    return res.status(400).json({ error: 'This report has no account or network on record to suspend.' });
  }
  res.json({ item: moderationView(db.prepare('SELECT * FROM issues WHERE id = ?').get(row.id)) });
});

router.post('/admin/issues/:id/unsuspend-reporter', requireCan('moderate'), (req, res) => {
  const row = adminIssue(req, res);
  if (!row) return;
  if (row.created_by) db.prepare('UPDATE users SET suspended_at = NULL WHERE id = ?').run(row.created_by);
  if (row.reporter_network) db.prepare('DELETE FROM blocked_networks WHERE network = ?').run(row.reporter_network);
  logActivity(req, 'unsuspend', row.id);
  res.json({ item: moderationView(db.prepare('SELECT * FROM issues WHERE id = ?').get(row.id)) });
});

// ---------- Roles (admin) ----------
router.get('/admin/roles', requireCan('assign_roles'), (req, res) => {
  const staff = db.prepare("SELECT id, name, email, role FROM users WHERE role != 'resident' ORDER BY role, name").all();
  res.json({ roles: ROLES.map((role) => ({ role, label: ROLE_LABELS[role] })), staff });
});

router.post('/admin/roles', requireCan('assign_roles'), (req, res) => {
  const email = cleanEmailFrom(req.body?.email);
  const role = req.body?.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Choose a valid role.' });
  const user = db.prepare('SELECT id, name, email, role, verified_at FROM users WHERE email = ?').get(email);
  if (!user || !user.verified_at) return res.status(404).json({ error: 'No confirmed account uses that email. They need to sign up and confirm first.' });
  if (req.user && user.id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'You can’t remove your own admin role. Ask another admin, or use the coordinator token.' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
  logActivity(req, 'role', user.id, `${user.role} → ${role}`);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role, roleLabel: ROLE_LABELS[role] } });
});

router.get('/admin/activity', requireCan('moderate'), (req, res) => {
  const rows = db.prepare(`SELECT activity_log.*, users.name AS actor_name FROM activity_log
    LEFT JOIN users ON activity_log.actor = 'user:' || users.id ORDER BY at DESC LIMIT 50`).all();
  res.json({ activity: rows.map((row) => ({ at: row.at, who: row.actor === 'token' ? 'Coordinator token' : row.actor_name || 'Deleted account', action: row.action, target: row.target, detail: row.detail })) });
});

// ---------- Phone notifications ----------
router.get('/push/key', (req, res) => res.json({ publicKey: notifier.publicKey() }));

router.post('/push/subscribe', requireVerifiedUser, limit({ name: 'push', max: 20, windowMs: 60 * 60 * 1000, by: 'user' }), (req, res) => {
  if (!notifier.saveSubscription(req.user.id, req.body?.subscription)) return res.status(400).json({ error: 'That notification subscription isn’t valid.' });
  res.json({ push: true });
});

router.delete('/push/subscribe', requireVerifiedUser, (req, res) => {
  notifier.removeSubscription(req.user.id, req.body?.endpoint);
  res.json({ push: notifier.hasPush(req.user.id) });
});

// ---------- Share previews ----------
// What a shared link (/r/<id>) shows in a text message or social post.
router.checkStaleReports = () => checkStaleReports();
router.sharePreview = (id) => {
  const row = db.prepare(`SELECT issues.* FROM issues LEFT JOIN users ON users.id = issues.created_by
    WHERE issues.id = ? AND issues.hidden_at IS NULL AND users.suspended_at IS NULL`).get(String(id));
  if (!row) return null;
  const photo = db.prepare('SELECT id FROM issue_photos WHERE issue_id = ? ORDER BY position LIMIT 1').get(row.id);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    area: row.distance,
    supporters: endorsementTotal(row),
    goal: GOAL,
    image: photo ? `${appUrl()}/api/photos/${photo.id}` : `${appUrl()}/og-default.png`,
    url: `${appUrl()}/r/${row.id}`,
  };
};

jobs.start();

// Used by server.js for the health check and a clean shutdown.
router.ping = () => db.prepare('SELECT 1').get();
router.close = () => {
  jobs.stop();
  try { if (db.isOpen !== false) db.close(); } catch (error) { /* already closed */ }
};

module.exports = router;