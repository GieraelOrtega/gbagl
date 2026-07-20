const crypto = require('crypto');
const {
  appendCookie,
  createSignedValue,
  parseCookies,
  safeEqual,
  serializeCookie,
  verifySignedValue,
} = require('../lib/cookies');

const CSRF_COOKIE = 'gbagl_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createCsrfProtection({ secret, secure }) {
  return function csrfProtection(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    let token = verifySignedValue(cookies[CSRF_COOKIE], secret);

    if (!token) {
      token = crypto.randomBytes(32).toString('base64url');
      appendCookie(res, serializeCookie(
        CSRF_COOKIE,
        createSignedValue(token, secret),
        { maxAge: 60 * 60 * 24, secure },
      ));
    }

    res.locals.csrfToken = token;
    if (SAFE_METHODS.has(req.method)) return next();

    const supplied = req.body && req.body._csrf;
    if (typeof supplied === 'string' && safeEqual(supplied, token)) return next();

    res.set('Cache-Control', 'no-store');
    return res.status(403).render('error', {
      title: 'Request Rejected | GBAGL',
      page: '',
      status: 403,
      message: 'This form expired or could not be verified. Go back, refresh the page, and try again.',
    });
  };
}

module.exports = { CSRF_COOKIE, createCsrfProtection };
