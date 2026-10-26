// One place that decides who hears about what, and sends it by email and phone push.
// People control both: email updates in their account, and phone notifications per device.
const webpush = require('web-push');

function createNotifier({ db, jobs, sendEmail, emailReady, hashToken, appUrl, crypto }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_user_idx ON push_subscriptions(user_id);
  `);

  // Push keys (VAPID) are made once and kept in the database, so there's nothing to set up.
  const setting = (key) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value;
  let publicKey = process.env.VAPID_PUBLIC_KEY || setting('vapid_public');
  let privateKey = process.env.VAPID_PRIVATE_KEY || setting('vapid_private');
  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('vapid_public', ?)").run(publicKey);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('vapid_private', ?)").run(privateKey);
  }
  const contact = (process.env.SMTP_FROM || '').match(/<([^>]+)>/)?.[1] || (process.env.SMTP_FROM || '').trim();
  // Push services want a contact: the sender email, else the https site address. Local development
  // (no email, plain http) gets a placeholder so the server always starts.
  const site = appUrl();
  const subject = contact.includes('@') ? `mailto:${contact}` : site.startsWith('https://') ? site : 'mailto:sidewalk@example.com';
  webpush.setVapidDetails(subject, publicKey, privateKey);

  function saveSubscription(userId, subscription) {
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000) return false;
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) return false;
    db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(endpoint, userId, p256dh, auth, Date.now());
    return true;
  }

  function removeSubscription(userId, endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint || ''));
  }

  function hasPush(userId) {
    return Boolean(db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ?').get(userId));
  }

  async function pushTo(userId, message) {
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
    await Promise.allSettled(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(message),
          { TTL: 24 * 60 * 60 },
        );
      } catch (error) {
        // The phone unsubscribed or the browser forgot it: clean up quietly.
        if (error.statusCode === 404 || error.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        else throw error;
      }
    }));
  }

  async function emailTo(user, { subject, text, url }) {
    if (!emailReady() || !user.email_updates) return;
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO email_unsubscribe_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(hashToken(token), user.id, Date.now());
    await sendEmail({
      to: user.email,
      subject,
      text: `${text}\n\n${url ? `Open it: ${url}\n\n` : ''}Turn off Sidewalk update emails: ${appUrl()}/api/email/unsubscribe?token=${token}`,
    });
  }

  // Queued so the action that triggered it (an endorsement, a status change) returns right away.
  jobs.register('notify', async ({ userIds, subject, text, title, body, path }) => {
    const url = path ? `${appUrl()}${path}` : appUrl();
    for (const userId of userIds) {
      const user = db.prepare('SELECT id, email, email_updates FROM users WHERE id = ? AND verified_at IS NOT NULL AND suspended_at IS NULL').get(userId);
      if (!user) continue;
      const results = await Promise.allSettled([
        emailTo(user, { subject, text, url }),
        pushTo(user.id, { title, body, url: path || '/' }),
      ]);
      results.filter((r) => r.status === 'rejected').forEach((r) => console.error(`Notification to ${user.id} failed:`, r.reason?.message || r.reason));
    }
  });

  // notify({ userIds, subject, text, title, body, path }): email subject/text, push title/body,
  // and the link inside Sidewalk both point to (`path`, like /r/<id>).
  function notify(message) {
    const userIds = [...new Set(message.userIds || [])].filter(Boolean);
    if (userIds.length) jobs.schedule('notify', { ...message, userIds });
  }

  return { notify, publicKey: () => publicKey, saveSubscription, removeSubscription, hasPush };
}

module.exports = { createNotifier };
