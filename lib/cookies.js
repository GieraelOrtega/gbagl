const crypto = require('crypto');

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createSignedValue(value, secret) {
  return `${value}.${sign(value, secret)}`;
}

function verifySignedValue(signedValue, secret) {
  if (typeof signedValue !== 'string') return null;
  const separator = signedValue.lastIndexOf('.');
  if (separator <= 0) return null;
  const value = signedValue.slice(0, separator);
  const signature = signedValue.slice(separator + 1);
  return safeEqual(signature, sign(value, secret)) ? value : null;
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, item) => {
    const separator = item.indexOf('=');
    if (separator === -1) return cookies;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, options.maxAge)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite || 'Strict'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function appendCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  if (!current) return res.setHeader('Set-Cookie', cookie);
  return res.setHeader('Set-Cookie', Array.isArray(current) ? [...current, cookie] : [current, cookie]);
}

function clearCookie(res, name, secure) {
  appendCookie(res, serializeCookie(name, '', { maxAge: 0, secure }));
}

module.exports = {
  appendCookie,
  clearCookie,
  createSignedValue,
  parseCookies,
  safeEqual,
  serializeCookie,
  verifySignedValue,
};
