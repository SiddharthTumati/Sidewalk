// Anti-abuse helpers: Cloudflare Turnstile bot check, throwaway-email detection,
// a link/profanity filter for public text, and privacy-safe network fingerprints.
const crypto = require('node:crypto');
const { isDisposableEmailDomain } = require('disposable-email-domains-js');

// ---------- Cloudflare Turnstile ----------
function turnstileEnabled() {
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

function turnstileSiteKey() {
  return turnstileEnabled() ? process.env.TURNSTILE_SITE_KEY : null;
}

async function verifyTurnstile(token, ip) {
  if (!turnstileEnabled()) return { ok: true };
  if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false };
  const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json();
    if (!data.success) console.warn('Turnstile rejected a token:', (data['error-codes'] || []).join(', '));
    return { ok: Boolean(data.success) };
  } catch (error) {
    console.error('Turnstile check failed:', error.message);
    return { ok: false };
  }
}

// Express middleware. `when(req)` decides whether this request needs the check.
function requireHuman(when = () => true) {
  return async (req, res, next) => {
    if (!turnstileEnabled() || !when(req)) return next();
    const { ok } = await verifyTurnstile(req.body?.turnstileToken, req.ip);
    if (!ok) return res.status(400).json({ error: 'Please complete the “I’m human” check and try again.', field: 'turnstile', turnstile: true });
    next();
  };
}

// ---------- Throwaway email addresses ----------
function isThrowawayEmail(email) {
  const domain = String(email).split('@').pop().toLowerCase();
  const parts = domain.split('.');
  // Check the domain and each parent (x.mailinator.com → mailinator.com).
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (isDisposableEmailDomain(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// ---------- Text filter for public posts ----------
const LINK_PATTERN = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|info|biz|io|co|ru|cn|xyz|top|click|link|site|online|shop|store|app|live|win|loan|ly|me|tk|gg)\b)/i;

// Common strong profanity and slurs. Extra words can be added with BLOCKED_WORDS
// (comma-separated) in the server environment.
const BASE_BLOCKED = [
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch', 'bastard', 'asshole',
  'pussy', 'cunt', 'whore', 'slut', 'porn', 'nigger', 'nigga', 'faggot', 'fag',
  'retard', 'retarded', 'spic', 'chink', 'kike', 'tranny',
];
const extraBlocked = (process.env.BLOCKED_WORDS || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
const BLOCKED = new Set([...BASE_BLOCKED, ...extraBlocked]);

// Undo common disguises: f.u.c.k, fuuuck, sh1t, $hit, @ss.
function normalizeForFilter(text) {
  return String(text).toLowerCase()
    .replace(/[0134578@$!|]/g, (c) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' })[c])
    .replace(/(\w)[._*\-]+(?=\w)/g, '$1')
    .replace(/(\w)\1{2,}/g, '$1$1');
}

// Word starts that are offensive in any form (sh1thead, f*cking, fck). Kept short on
// purpose so normal words and street names aren't caught.
const BLOCKED_ROOTS = /(^|[^a-z])(f+u*c+k|f+v+c+k|s+h+i+t(?!t?ake)|n+i+g+(e+r|a|g))/;

function containsBlockedWord(text) {
  const normalized = normalizeForFilter(text);
  const words = normalized.split(/[^a-z]+/).filter(Boolean);
  if (words.some((word) => BLOCKED.has(word) || BLOCKED.has(word.replace(/(\w)\1/g, '$1')))) return true;
  // Also check with masking symbols removed: "f*cking" -> "fcking".
  return BLOCKED_ROOTS.test(normalized) || BLOCKED_ROOTS.test(String(text).toLowerCase().replace(/[*#%^~]/g, ''));
}

// Returns an error message, or null if the text is fine.
function checkPublicText(text, { allowLinks = false } = {}) {
  if (!allowLinks && LINK_PATTERN.test(text)) return 'Links and web addresses aren’t allowed in reports. Describe the problem in your own words.';
  if (containsBlockedWord(text)) return 'Please keep reports respectful. Remove the offensive language and try again.';
  return null;
}

// ---------- Network fingerprints ----------
// We never store raw IP addresses. Instead we store a keyed hash, so we can tell
// "same network" without being able to recover the address.
let networkKey = null;
function setNetworkKey(key) {
  networkKey = key;
}

function networkId(ip) {
  if (!networkKey || !ip) return null;
  // Group IPv6 addresses by their /64 network, which is usually one household.
  const normalized = ip.includes(':') && !ip.startsWith('::ffff:') ? ip.split(':').slice(0, 4).join(':') : ip.replace(/^::ffff:/, '');
  return crypto.createHmac('sha256', networkKey).update(normalized).digest('hex').slice(0, 32);
}

module.exports = {
  turnstileEnabled,
  turnstileSiteKey,
  verifyTurnstile,
  requireHuman,
  isThrowawayEmail,
  checkPublicText,
  setNetworkKey,
  networkId,
};
