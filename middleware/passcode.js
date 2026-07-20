const {
  appendCookie,
  clearCookie,
  createSignedValue,
  parseCookies,
  safeEqual,
  serializeCookie,
  verifySignedValue,
} = require('../lib/cookies');

const COOKIE_NAME = 'gbagl_unlocked';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

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

function createPasscodeAuth(config) {
  function isValidPasscode(candidate) {
    return typeof candidate === 'string' && safeEqual(candidate, config.sitePasscode);
  }

  function isUnlocked(req) {
    const signed = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const value = verifySignedValue(signed, config.cookieSecret);
    if (!value) return false;
    const [label, expiresAt] = value.split(':');
    return label === 'unlocked' && Number(expiresAt) > Date.now();
  }

  function setUnlockCookie(res) {
    const value = `unlocked:${Date.now() + (COOKIE_MAX_AGE_SECONDS * 1000)}`;
    appendCookie(res, serializeCookie(
      COOKIE_NAME,
      createSignedValue(value, config.cookieSecret),
      { maxAge: COOKIE_MAX_AGE_SECONDS, secure: config.production },
    ));
  }

  function clearUnlockCookie(res) {
    clearCookie(res, COOKIE_NAME, config.production);
  }

  function requirePasscode(req, res, next) {
    res.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    });

    if (isUnlocked(req)) return next();

    res.set('X-GBAGL-Authorization-Lost', '1');
    return res.status(401).render('lock', {
      title: 'GBAGL — Locked',
      error: null,
      next: safeDestination(req.originalUrl),
    });
  }

  return {
    clearUnlockCookie,
    isUnlocked,
    isValidPasscode,
    requirePasscode,
    setUnlockCookie,
  };
}

module.exports = {
  COOKIE_NAME,
  createPasscodeAuth,
  safeDestination,
};
