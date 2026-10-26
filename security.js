// Security helpers: response headers, rate limits, daily AI caps, and input cleaning.
// Everything is kept in memory, which is fine for a single server; counters reset on restart.

// ---------- Security headers ----------
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  // Leaflet and a few popups set inline style attributes.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://server.arcgisonline.com",
  "connect-src 'self' https://nominatim.openstreetmap.org",
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Camera stays allowed for "Take photo"; location for "near me".
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

// ---------- Rate limits ----------
const buckets = new Map();

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Count one hit for `key`; returns { limited, retryAfter }.
function hit(key, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.expiresAt <= now) bucket = { count: 0, expiresAt: now + windowMs };
  bucket.count += 1;
  buckets.set(key, bucket);
  return { limited: bucket.count > max, retryAfter: Math.ceil((bucket.expiresAt - now) / 1000) };
}

function peek(key) {
  const bucket = buckets.get(key);
  return bucket && bucket.expiresAt > Date.now() ? bucket.count : 0;
}

function clear(key) {
  buckets.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key);
}, 5 * 60 * 1000).unref();

function tooMany(res, retryAfter, message) {
  res.setHeader('Retry-After', String(retryAfter));
  return res.status(429).json({ error: message, retryAfter });
}

// limit({ name, max, windowMs, by, message, successOnly })
//  by: 'ip' (default) | 'user' (falls back to IP for guests) | 'ip+user' (counts both)
//  successOnly: only count requests that succeed, so fixing a typo doesn't use up the limit.
function limit({ name, max, windowMs, by = 'ip', message, successOnly = false }) {
  const msg = message || 'You’re doing that too often. Please wait a bit and try again.';
  return (req, res, next) => {
    const keys = [];
    const userId = req.user?.id;
    if (by === 'ip' || by === 'ip+user' || (by === 'user' && !userId)) keys.push(`${name}:ip:${clientIp(req)}`);
    if ((by === 'user' || by === 'ip+user') && userId) keys.push(`${name}:user:${userId}`);
    if (successOnly) {
      for (const key of keys) {
        if (peek(key) >= max) return tooMany(res, Math.ceil((buckets.get(key).expiresAt - Date.now()) / 1000), msg);
      }
      res.on('finish', () => {
        if (res.statusCode < 400) for (const key of keys) hit(key, max, windowMs);
      });
      return next();
    }
    for (const key of keys) {
      const result = hit(key, max, windowMs);
      if (result.limited) return tooMany(res, result.retryAfter, msg);
    }
    next();
  };
}

// ---------- Daily AI caps ----------
// Protects the free AI quota: a per-person daily cap and a site-wide daily cap.
function msUntilUtcMidnight() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
}

const AI_PER_PERSON = Number(process.env.AI_DAILY_LIMIT_PER_USER || 40);
const AI_SITE_WIDE = Number(process.env.AI_DAILY_LIMIT || 800);

// Returns null if allowed, or a message if a cap is reached. `who` is a user id or IP.
function takeAiCredit(who) {
  const windowMs = msUntilUtcMidnight();
  if (peek('ai:site') >= AI_SITE_WIDE) return 'Cony has answered a lot of questions today and is resting for the whole site. Please try again tomorrow.';
  if (who && peek(`ai:who:${who}`) >= AI_PER_PERSON) return 'You’ve reached today’s limit for Cony. Please try again tomorrow.';
  hit('ai:site', AI_SITE_WIDE, windowMs);
  if (who) hit(`ai:who:${who}`, AI_PER_PERSON, windowMs);
  return null;
}

function aiDailyCap(req, res, next) {
  const message = takeAiCredit(req.user?.id ? `u${req.user.id}` : clientIp(req));
  if (message) return res.status(429).json({ error: message });
  next();
}

// ---------- Coordinator token lockout ----------
const ADMIN_MAX_FAILS = 5;
const ADMIN_LOCK_MS = 15 * 60 * 1000;

function adminLocked(req) {
  return peek(`admin-fail:${clientIp(req)}`) >= ADMIN_MAX_FAILS;
}

function recordAdminFailure(req) {
  hit(`admin-fail:${clientIp(req)}`, ADMIN_MAX_FAILS, ADMIN_LOCK_MS);
}

function clearAdminFailures(req) {
  clear(`admin-fail:${clientIp(req)}`);
}

// ---------- Input cleaning ----------
// Removes invisible control characters (keeps newlines and tabs), collapses runs of
// blank lines, and trims.
function cleanText(value, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  let text = value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, '');
  text = multiline ? text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : text.replace(/\s+/g, ' ');
  return text.trim();
}

// Generous box around North and South Carolina.
const CAROLINAS = { minLat: 31.9, maxLat: 36.7, minLng: -84.4, maxLng: -75.3 };
function inCarolinas(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= CAROLINAS.minLat && lat <= CAROLINAS.maxLat
    && lng >= CAROLINAS.minLng && lng <= CAROLINAS.maxLng;
}

module.exports = {
  securityHeaders,
  limit,
  clientIp,
  aiDailyCap,
  takeAiCredit,
  adminLocked,
  recordAdminFailure,
  clearAdminFailures,
  cleanText,
  inCarolinas,
};
