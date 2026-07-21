const crypto = require('crypto');
const {
  appendCookie,
  clearCookie,
  createSignedValue,
  parseCookies,
  safeEqual,
  serializeCookie,
  verifySignedValue,
} = require('../lib/cookies');

const ACCOUNT_COOKIE = 'gbagl_account';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createAccountAuth(config) {
  const maxAge = config.accountCookieHours * 60 * 60;
  const accounts = new Map(
    config.accounts.map((account) => [account.username.toLowerCase(), account]),
  );

  function publicAccount(account) {
    return Object.freeze({
      username: account.username,
      displayName: account.displayName,
      role: account.role,
    });
  }

  function credentialTag(account) {
    return crypto
      .createHmac('sha256', config.cookieSecret)
      .update(`${account.username}\0${account.password}`)
      .digest('base64url')
      .slice(0, 24);
  }

  function authenticate(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string') return null;
    const account = accounts.get(username.trim().toLowerCase());
    return account && safeEqual(password, account.password)
      ? publicAccount(account)
      : null;
  }

  function currentUser(req) {
    const signed = parseCookies(req.headers.cookie)[ACCOUNT_COOKIE];
    const value = verifySignedValue(signed, config.cookieSecret);
    if (!value) return null;
    const [version, username, tag, expiresAt] = value.split(':');
    const account = accounts.get(username);
    if (
      version !== 'v1'
      || !account
      || !safeEqual(tag, credentialTag(account))
      || Number(expiresAt) <= Date.now()
    ) return null;
    return publicAccount(account);
  }

  function isMember(req) {
    return currentUser(req) !== null;
  }

  function isAdmin(req) {
    return currentUser(req)?.role === 'admin';
  }

  function setAccountCookie(res, user) {
    const account = accounts.get(user?.username?.toLowerCase());
    if (!account) throw new Error('Cannot create a session for an unknown account');
    const value = [
      'v1',
      account.username,
      credentialTag(account),
      Date.now() + (maxAge * 1000),
    ].join(':');
    appendCookie(res, serializeCookie(
      ACCOUNT_COOKIE,
      createSignedValue(value, config.cookieSecret),
      { maxAge, secure: config.production },
    ));
  }

  function clearAccountCookie(res) {
    clearCookie(res, ACCOUNT_COOKIE, config.production);
  }

  function forbidden(res, message) {
    res.set('Cache-Control', 'no-store');
    return res.status(403).render('error', {
      title: 'Access denied | GBAGL',
      page: 'settings',
      status: 403,
      message,
    });
  }

  function requireAccount(req, res, next) {
    if (isMember(req)) return next();
    return res.redirect(303, '/settings/login');
  }

  function requireMember(req, res, next) {
    if (isMember(req)) return next();
    return forbidden(
      res,
      'Sign in as Gierael or Kim from Settings before making changes.',
    );
  }

  function requireMemberWrite(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    return requireMember(req, res, next);
  }

  function requireAdmin(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.redirect(303, '/settings/login');
    if (user.role === 'admin') return next();
    return forbidden(res, 'This setting is available only to Gierael.');
  }

  return {
    authenticate,
    clearAccountCookie,
    currentUser,
    isAdmin,
    isMember,
    requireAccount,
    requireAdmin,
    requireMember,
    requireMemberWrite,
    setAccountCookie,
  };
}

module.exports = { ACCOUNT_COOKIE, createAccountAuth };
