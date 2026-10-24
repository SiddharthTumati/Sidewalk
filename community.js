const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const nodemailer = require('nodemailer');
const { Type } = require('@google/genai');
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
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS supports_issue_idx ON supports(issue_id);
  CREATE INDEX IF NOT EXISTS issue_events_issue_idx ON issue_events(issue_id, created_at);
`);

const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
if (!userColumns.has('email_unsubscribe_hash')) db.exec('ALTER TABLE users ADD COLUMN email_unsubscribe_hash TEXT');
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

const hasSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
const authAttempts = new Map();
const mailer = hasSmtp ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER && process.env.SMTP_PASS
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
}) : null;

function sendEmail(message) {
  if (!mailer) throw new Error('SMTP is not configured. Add SMTP_HOST and SMTP_FROM to .env.');
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
    db.prepare('UPDATE users SET email_unsubscribe_hash = ? WHERE id = ?').run(hashToken(unsubscribeToken), id);
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
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      config: {
        systemInstruction: 'Review a resident report for clarity and civic routing. Do not claim the reported condition is true or verified on site. Never invent laws or safety facts. Return only a concise completeness note and suggested urgency.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            urgency: { type: Type.STRING, enum: ['Routine', 'Elevated', 'Urgent'] },
            summary: { type: Type.STRING },
          },
          required: ['urgency', 'summary'],
        },
      },
      contents: `Issue category: ${issue.category_label}\nLocation: ${issue.distance}\nTitle: ${issue.title}\nDescription: ${issue.description}`,
    });
    const review = JSON.parse(response.text || '{}');
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
    photo: row.photo_data,
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

router.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null, emailConfigured: hasSmtp });
  res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, emailUpdates: Boolean(req.user.email_updates) }, emailConfigured: hasSmtp });
});

router.post('/auth/register', rateLimit(5, 60 * 60 * 1000), async (req, res) => {
  const { name, email, password, emailUpdates } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (cleanName.length < 2 || cleanName.length > 60) return res.status(400).json({ error: 'Enter a name between 2 and 60 characters.' });
  if (cleanEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) return res.status(400).json({ error: 'Use a password between 12 and 200 characters.' });
  if (!mailer && process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'Email is not configured yet. Add SMTP settings to .env before creating accounts.' });

  const id = crypto.randomUUID();
  const token = mailer ? crypto.randomBytes(32).toString('hex') : null;
  const tokenHash = token ? hashToken(token) : null;
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  try {
    const passwordHash = await hashPassword(password);
    db.prepare(`INSERT INTO users (id, name, email, password_hash, verify_token_hash, verify_expires_at, email_updates, email_unsubscribe_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, cleanName, cleanEmail, passwordHash, tokenHash, token ? expires : null, hasSmtp && emailUpdates !== false ? 1 : 0, null, Date.now());
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'An account already uses this email address.' });
    console.error('Could not create account:', error.message);
    return res.status(500).json({ error: 'Could not create your account. Please try again.' });
  }

  if (mailer) {
    const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
    const verificationUrl = `${appUrl}/api/auth/verify?token=${token}`;
    try {
      await sendEmail({
        to: cleanEmail,
        subject: 'Verify your Sidewalk account',
        text: `Hi ${cleanName},\n\nVerify your Sidewalk account using this link (valid for 24 hours):\n${verificationUrl}\n\nIf you did not create this account, you can ignore this email.`,
      });
    } catch (error) {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      console.error('Verification email failed:', error.message);
      return res.status(502).json({ error: 'Could not send the verification email. Check the SMTP settings and try again.' });
    }
    return res.status(201).json({ message: 'Check your inbox for a verification link. It is valid for 24 hours.', emailConfigured: true });
  }
  const verifiedAt = Date.now();
  db.prepare('UPDATE users SET verified_at = ? WHERE id = ?').run(verifiedAt, id);
  setSession(res, id);
  res.status(201).json({
    message: 'Account created and signed in for local testing. SMTP is not configured, so no email was sent and email updates are disabled.',
    user: { id, name: cleanName, email: cleanEmail, emailUpdates: false },
    emailConfigured: false,
  });
});

router.get('/auth/verify', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const user = token ? db.prepare('SELECT id FROM users WHERE verify_token_hash = ? AND verify_expires_at > ?').get(hashToken(token), Date.now()) : null;
  if (!user) return res.status(400).send('This verification link is invalid or expired. Please create your account again.');
  db.prepare('UPDATE users SET verified_at = ?, verify_token_hash = NULL, verify_expires_at = NULL WHERE id = ?').run(Date.now(), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  setSession(res, user.id);
  res.redirect('/?verified=1');
});

router.post('/auth/login', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT id, name, email, password_hash, verified_at, email_updates FROM users WHERE email = ?').get(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (!user.verified_at) {
    if (!mailer && process.env.NODE_ENV !== 'production') {
      const verifiedAt = Date.now();
      db.prepare('UPDATE users SET verified_at = ?, verify_token_hash = NULL, verify_expires_at = NULL WHERE id = ?').run(verifiedAt, user.id);
      user.verified_at = verifiedAt;
      user.email_updates = 0;
    } else {
      return res.status(403).json({ error: 'Verify your email before signing in. Check your inbox for the verification link.' });
    }
  }
  setSession(res, user.id);
  res.json({ user: { id: user.id, name: user.name, email: user.email, emailUpdates: Boolean(user.email_updates) }, emailConfigured: hasSmtp });
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
  const categories = { safety: 'Street safety', access: 'Accessibility', parks: 'Parks & public space', lighting: 'Street lighting', other: 'Neighborhood issue' };
  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 70) return res.status(400).json({ error: 'Issue titles must be 3 to 70 characters.' });
  if (!categories[category]) return res.status(400).json({ error: 'Choose a valid issue category.' });
  if (typeof description !== 'string' || description.trim().length < 5 || description.trim().length > 400) return res.status(400).json({ error: 'Issue descriptions must be 5 to 400 characters.' });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(400).json({ error: 'Choose a valid map location.' });
  if (typeof photo === 'string' && photo.length > 2_000_000) return res.status(413).json({ error: 'Choose a photo smaller than 1.5 MB.' });
  if (photo && (typeof photo !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(photo))) return res.status(400).json({ error: 'Photos must be PNG, JPEG, or WebP images.' });
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  db.prepare(`INSERT INTO issues (id, title, category, category_label, description, distance, lat, lng, photo_data, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, title.trim(), category, categories[category], description.trim(), String(distance || 'The Carolinas').slice(0, 100), lat, lng, photo || null, req.user?.id || null, createdAt);
  db.prepare('INSERT INTO issue_events (issue_id, status, note, created_at) VALUES (?, ?, ?, ?)')
    .run(id, 'submitted', 'Issue submitted to the community map.', createdAt);
  if (req.user) db.prepare('INSERT INTO supports (issue_id, user_id, created_at) VALUES (?, ?, ?)').run(id, req.user.id, Date.now());
  if (req.user) db.prepare('INSERT OR IGNORE INTO issue_subscriptions (issue_id, user_id, created_at) VALUES (?, ?, ?)').run(id, req.user.id, createdAt);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  res.status(201).json({ issue: serializeIssue(issue, req.user?.id) });
  if (req.app.locals.gemini) setImmediate(() => reviewIssueWithAi(id, req.app.locals.gemini));
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