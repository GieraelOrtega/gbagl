const {
  appendCookie,
  clearCookie,
  createSignedValue,
  parseCookies,
  safeEqual,
  serializeCookie,
  verifySignedValue,
} = require('../lib/cookies');

const ADMIN_COOKIE = 'gbagl_admin';

function createAdminAuth(config) {
  const maxAge = config.adminCookieHours * 60 * 60;

  function isAdmin(req) {
    const signed = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    const value = verifySignedValue(signed, config.cookieSecret);
    if (!value) return false;
    const [label, expiresAt] = value.split(':');
    return label === 'admin' && Number(expiresAt) > Date.now();
  }

  function isValidPassword(candidate) {
    return typeof candidate === 'string' && safeEqual(candidate, config.adminPassword);
  }

  function setAdminCookie(res) {
    const value = `admin:${Date.now() + (maxAge * 1000)}`;
    appendCookie(res, serializeCookie(
      ADMIN_COOKIE,
      createSignedValue(value, config.cookieSecret),
      { maxAge, secure: config.production },
    ));
  }

  function clearAdminCookie(res) {
    clearCookie(res, ADMIN_COOKIE, config.production);
  }

  function requireAdmin(req, res, next) {
    if (isAdmin(req)) {
      res.locals.isAdmin = true;
      return next();
    }
    return res.redirect(303, '/admin/login');
  }

  return {
    clearAdminCookie,
    isAdmin,
    isValidPassword,
    requireAdmin,
    setAdminCookie,
  };
}

module.exports = { ADMIN_COOKIE, createAdminAuth };
