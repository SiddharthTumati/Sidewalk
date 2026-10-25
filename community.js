const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const nodemailer = require('nodemailer');
const { DatabaseSync } = require('node:sqlite');

const router = express.Router();
const scrypt = promisify(crypto.scrypt);
const GOAL = 50;
const PRIORITY_THRESHOLD = 10;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const ISSUE_STAGES = ['submitted', 'ai_reviewed', 'community_priority', 'sent_to_agency', 'in_progress', 'resolved'];
const db = new DatabaseSync(process.env.SQLITE_PATH || path.join(__dirname, 'sidewalk.sqlite'));

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
  return { mime, data };
}

const insertPhoto = db.prepare('INSERT INTO issue_photos (id, issue_id, mime, data, position, created_at) VALUES (?, ?, ?, ?, ?, ?)');

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
  return db.prepare(`SELECT users.id, users.name, users.email, users.email_updates
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.verified_at IS NOT NULL`)
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

async function sendIssueStatusEmails(issue, status, note) {
  if (!mailer) return;
  const recipients = db.prepare(`
    SELECT id, email FROM users
    WHERE verified_at IS NOT NULL AND email_updates = 1 AND id = ?
    UNION
    SELECT users.id, users.email FROM issue_subscriptions
    JOIN users ON users.id = issue_subscriptions.user_id
    WHERE issue_subscriptions.issue_id = ? AND users.verified_at IS NOT NULL AND users.email_updates = 1
  `).all(issue.created_by, issue.id);
  const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
  await Promise.allSettled(recipients.map(async ({ id, email }) => {
    const unsubscribeToken = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO email_unsubscribe_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)')
      .run(hashToken(unsubscribeToken), id, Date.now());
    await sendEmail({
      to: email,
      subject: `Sidewalk issue update: ${issue.title}`,
      text: `An issue you follow has a new status: ${status.replaceAll('_', ' ')}.\n\n${issue.title}\n${issue.distance}\n${note}\n\nTrack this issue: ${appUrl}/#tracker\n\nTurn off petition and issue emails: ${appUrl}/api/email/unsubscribe?token=${unsubscribeToken}`,
    });
  }));
}

async function transitionIssue(issue, status, note) {
  const now = Date.now();
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 240) : `Status updated to ${status.replaceAll('_', ' ')}.`;
  db.prepare('UPDATE issues SET status = ?, status_updated_at = ? WHERE id = ?').run(status, now, issue.id);
  db.prepare('INSERT INTO issue_events (issue_id, status, note, created_at) VALUES (?, ?, ?, ?)')
    .run(issue.id, status, cleanNote, now);
  await sendIssueStatusEmails(issue, status, cleanNote);
  return { ...issue, status, status_updated_at: now };
}

async function reviewIssueWithAi(issueId, ai) {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
  if (!issue || issue.status !== 'submitted') return;
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

function serializeIssue(row, userId) {
  const signed = db.prepare('SELECT COUNT(*) AS total FROM supports WHERE issue_id = ?').get(row.id).total;
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
    distance: row.distance,
    lat: row.lat,
    lng: row.lng,
    photos: db.prepare('SELECT id FROM issue_photos WHERE issue_id = ? ORDER BY position ASC, created_at ASC').all(row.id)
      .map((photo) => `/api/photos/${photo.id}`),
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
  return { id: user.id, name: user.name, email: user.email, emailUpdates: Boolean(user.email_updates) };
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
  res.json({ user: req.user ? publicUser(req.user) : null, emailConfigured: hasSmtp });
});

router.post('/auth/register', rateLimit(8, 60 * 60 * 1000), async (req, res) => {
  const { name, password, emailUpdates } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanEmail = cleanEmailFrom(req.body?.email);
  if (cleanName.length < 2 || cleanName.length > 60) return res.status(400).json({ error: 'Enter a name between 2 and 60 characters.', field: 'name' });
  if (!validEmail(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address.', field: 'email' });
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

router.get('/auth/verify', (req, res) => {
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

router.post('/auth/forgot-password', rateLimit(5, 60 * 60 * 1000), async (req, res) => {
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

router.post('/auth/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

router.patch('/auth/preferences', requireVerifiedUser, (req, res) => {
  if (typeof req.body?.emailUpdates !== 'boolean') return res.status(400).json({ error: 'Choose whether to receive petition email updates.' });
  if (req.body.emailUpdates && !hasSmtp) return res.status(503).json({ error: 'Email updates cannot be enabled until SMTP is configured.' });
  db.prepare('UPDATE users SET email_updates = ? WHERE id = ?').run(req.body.emailUpdates ? 1 : 0, req.user.id);
  res.json({ emailUpdates: req.body.emailUpdates });
});

router.get('/email/unsubscribe', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return res.status(400).send('This unsubscribe link is invalid.');
  const user = db.prepare('SELECT user_id AS id FROM email_unsubscribe_tokens WHERE token_hash = ?').get(hashToken(token));
  if (!user) return res.status(400).send('This unsubscribe link is invalid or has already been used.');
  db.prepare('UPDATE users SET email_updates = 0 WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM email_unsubscribe_tokens WHERE user_id = ?').run(user.id);
  res.send('Email updates have been turned off for your Sidewalk account.');
});

router.get('/issues', (req, res) => {
  const rows = db.prepare('SELECT * FROM issues ORDER BY created_at DESC').all();
  res.json({
    issues: rows.map((row) => serializeIssue(row, req.user?.id)),
    priorityThreshold: PRIORITY_THRESHOLD,
    petitionGoal: GOAL,
    coordinatorConfigured: Boolean(process.env.ADMIN_TOKEN),
  });
});

router.get('/photos/:id', (req, res) => {
  const photo = db.prepare('SELECT mime, data FROM issue_photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });
  res.setHeader('Content-Type', photo.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(photo.data));
});

router.get('/issues/:id', (req, res) => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  res.json({ issue: serializeIssue(issue, req.user?.id), priorityThreshold: PRIORITY_THRESHOLD, petitionGoal: GOAL });
});

router.post('/issues/:id/subscribe', requireVerifiedUser, (req, res) => {
  const issue = db.prepare('SELECT id FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  db.prepare('INSERT OR IGNORE INTO issue_subscriptions (issue_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(issue.id, req.user.id, Date.now());
  res.json({ subscribed: true, emailAlertsEnabled: hasSmtp && Boolean(req.user.email_updates) });
});

router.delete('/issues/:id/subscribe', requireVerifiedUser, (req, res) => {
  db.prepare('DELETE FROM issue_subscriptions WHERE issue_id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ subscribed: false });
});

router.patch('/issues/:id/status', async (req, res) => {
  if (!process.env.ADMIN_TOKEN) return res.status(503).json({ error: 'Issue status changes are not configured. Set ADMIN_TOKEN on the server.' });
  if (!isCoordinator(req)) return res.status(403).json({ error: 'Coordinator token is invalid.' });
  const { status, note } = req.body || {};
  if (!ISSUE_STAGES.includes(status) || status === 'submitted') return res.status(400).json({ error: 'Choose a valid next issue status.' });
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  const endorsementCount = issue.base_supporters + db.prepare('SELECT COUNT(*) AS total FROM supports WHERE issue_id = ?').get(issue.id).total;
  const allowedNext = {
    submitted: [],
    ai_reviewed: endorsementCount >= PRIORITY_THRESHOLD ? ['community_priority', 'sent_to_agency'] : ['sent_to_agency'],
    community_priority: ['sent_to_agency'],
    sent_to_agency: ['in_progress'],
    in_progress: ['resolved'],
    resolved: [],
  }[issue.status || 'submitted'];
  if (!allowedNext?.includes(status)) return res.status(409).json({ error: 'This status is not the next valid lifecycle stage. Priority requires 10 endorsements.' });
  try {
    const updated = await transitionIssue(issue, status, note);
    res.json({ issue: serializeIssue(db.prepare('SELECT * FROM issues WHERE id = ?').get(updated.id), req.user?.id), emailAlertsEnabled: hasSmtp });
  } catch (error) {
    console.error('Issue status updated, but notifications failed:', error.message);
    res.json({ issue: serializeIssue(db.prepare('SELECT * FROM issues WHERE id = ?').get(issue.id), req.user?.id), emailAlertsEnabled: false });
  }
});

router.post('/issues', async (req, res) => {
  const { title, category, description, distance, lat, lng, photo } = req.body || {};
  const rawPhotos = Array.isArray(req.body?.photos) ? req.body.photos : (photo ? [photo] : []);
  const categories = { safety: 'Street safety', access: 'Accessibility', parks: 'Parks & public space', lighting: 'Street lighting', other: 'Neighborhood issue' };
  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 70) return res.status(400).json({ error: 'Issue titles must be 3 to 70 characters.' });
  if (!categories[category]) return res.status(400).json({ error: 'Choose a valid issue category.' });
  if (typeof description !== 'string' || description.trim().length < 5 || description.trim().length > 400) return res.status(400).json({ error: 'Issue descriptions must be 5 to 400 characters.' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(400).json({ error: 'Choose a valid map location.' });
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
    .run(id, title.trim(), category, categories[category], description.trim(), String(distance || 'The Carolinas').slice(0, 100), lat, lng, req.user?.id || null, createdAt);
  photos.forEach(({ mime, data }, position) => insertPhoto.run(crypto.randomUUID(), id, mime, data, position, createdAt));
  db.prepare('INSERT INTO issue_events (issue_id, status, note, created_at) VALUES (?, ?, ?, ?)')
    .run(id, 'submitted', 'Issue submitted to the community map.', createdAt);
  if (req.user) db.prepare('INSERT INTO supports (issue_id, user_id, created_at) VALUES (?, ?, ?)').run(id, req.user.id, Date.now());
  if (req.user) db.prepare('INSERT OR IGNORE INTO issue_subscriptions (issue_id, user_id, created_at) VALUES (?, ?, ?)').run(id, req.user.id, createdAt);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  res.status(201).json({ issue: serializeIssue(issue, req.user?.id) });
  if (req.app.locals.ai) setImmediate(() => reviewIssueWithAi(id, req.app.locals.ai));
});

router.post('/issues/:id/support', requireVerifiedUser, async (req, res) => {
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found.' });
  try {
    db.prepare('INSERT INTO supports (issue_id, user_id, created_at) VALUES (?, ?, ?)').run(issue.id, req.user.id, Date.now());
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'You already supported this issue.' });
    throw error;
  }
  const count = issue.base_supporters + db.prepare('SELECT COUNT(*) AS total FROM supports WHERE issue_id = ?').get(issue.id).total;
  db.prepare('INSERT OR IGNORE INTO issue_subscriptions (issue_id, user_id, created_at) VALUES (?, ?, ?)').run(issue.id, req.user.id, Date.now());
  let priorityReached = false;
  if (count >= PRIORITY_THRESHOLD && ['submitted', 'ai_reviewed'].includes(issue.status)) {
    await transitionIssue(issue, 'community_priority', `Reached the ${PRIORITY_THRESHOLD}-endorsement community priority threshold.`);
    priorityReached = true;
  }
  let goalReached = false;
  if (count >= GOAL && !issue.goal_notified_at) {
    db.prepare('UPDATE issues SET goal_notified_at = ? WHERE id = ? AND goal_notified_at IS NULL').run(Date.now(), issue.id);
    goalReached = true;
    if (mailer) {
      const supporters = db.prepare(`SELECT DISTINCT users.id, users.email FROM supports
        JOIN users ON users.id = supports.user_id
        WHERE supports.issue_id = ? AND users.verified_at IS NOT NULL AND users.email_updates = 1`).all(issue.id);
      const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
      await Promise.allSettled(supporters.map(async ({ id, email }) => {
        const unsubscribeToken = crypto.randomBytes(32).toString('hex');
        db.prepare('INSERT INTO email_unsubscribe_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)')
          .run(hashToken(unsubscribeToken), id, Date.now());
        await sendEmail({
          to: email,
          subject: `Petition goal reached: ${issue.title}`,
          text: `The issue you supported has reached ${GOAL} local supporters.\n\n${issue.title}\n${issue.description}\n\nOpen Sidewalk to review the community's next steps: ${appUrl}\n\nTurn off petition email updates: ${appUrl}/api/email/unsubscribe?token=${unsubscribeToken}`,
        });
      }));
    }
  }
  res.json({ count, goalReached, priorityReached });
});

module.exports = router;