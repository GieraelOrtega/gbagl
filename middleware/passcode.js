const crypto = require('crypto');

const COOKIE_NAME = 'gbagl_unlocked';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const COOKIE_VALUE = 'unlocked';

const passcode = process.env.SITE_PASSCODE || '1208';
const signingSecret = process.env.PASSCODE_COOKIE_SECRET
  || crypto.randomBytes(32).toString('hex');

function sign(value) {
  return crypto
    .createHmac('sha256', signingSecret)
    .update(value)
    .digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isValidPasscode(candidate) {
  return typeof candidate === 'string' && safeEqual(candidate, passcode);
}

function createCookieValue() {
  return `${COOKIE_VALUE}.${sign(COOKIE_VALUE)}`;
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, item) => {
    const separator = item.indexOf('=');
    if (separator === -1) return cookies;

    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name) cookies[name] = value;
    return cookies;
  }, {});
}

function isUnlocked(req) {
  const value = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!value) return false;

  const separator = value.lastIndexOf('.');
  if (separator === -1) return false;

  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  return payload === COOKIE_VALUE && safeEqual(signature, sign(payload));
}

function setUnlockCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${createCookieValue()}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Strict${secure}`,
  );
}

function safeDestination(destination) {
  if (typeof destination !== 'string' || !destination.startsWith('/')) {
    return '/';
  }

  try {
    const base = new URL('https://gba.gl');
    const target = new URL(destination, base);

    return target.origin === base.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : '/';
  } catch {
    return '/';
  }
}

function requirePasscode(req, res, next) {
  res.set({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });

  if (isUnlocked(req)) return next();

  return res.status(401).render('lock', {
    title: 'GBAGL — Locked',
    error: null,
    next: safeDestination(req.originalUrl),
  });
}

module.exports = {
  isValidPasscode,
  requirePasscode,
  safeDestination,
  setUnlockCookie,
};
