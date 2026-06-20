const crypto = require('crypto');

const UNLOCK_COOKIE_NAME = 'gbagl_unlock';

const ANNIVERSARY_DATE = process.env.ANNIVERSARY_DATE || '';
let gateSecret = process.env.GATE_SECRET;

if (!ANNIVERSARY_DATE) {
  console.warn('⚠️  ANNIVERSARY_DATE is not set. Unlock attempts will fail until it is configured.');
}

if (!gateSecret) {
  gateSecret = crypto.randomBytes(32).toString('hex');
  console.warn(
    '⚠️  GATE_SECRET is not set. Generated a temporary secret for this process; ' +
    'unlock cookies will reset after restart.',
  );
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const index = part.indexOf('=');
      if (index === -1) return acc;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      try {
        acc[key] = decodeURIComponent(value);
      } catch {
        acc[key] = value;
      }
      return acc;
    }, {});
}

function signPayload(payload) {
  return crypto.createHmac('sha256', gateSecret).update(payload).digest('hex');
}

function createUnlockToken() {
  const payload = Buffer.from(`unlocked:${Date.now()}`).toString('base64url');
  const signature = signPayload(payload);
  return `${payload}.${signature}`;
}

function verifyUnlockToken(token) {
  if (typeof token !== 'string') return false;

  const splitIndex = token.lastIndexOf('.');
  if (splitIndex <= 0) return false;

  const payload = token.slice(0, splitIndex);
  const signature = token.slice(splitIndex + 1);
  const expectedSignature = signPayload(payload);

  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (providedBuffer.length !== expectedBuffer.length) return false;

  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return false;

  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    return decoded.startsWith('unlocked:');
  } catch {
    return false;
  }
}

function isUnlockedRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return verifyUnlockToken(cookies[UNLOCK_COOKIE_NAME]);
}

function isCorrectAnniversaryDate(dateValue) {
  return typeof dateValue === 'string' && dateValue === ANNIVERSARY_DATE;
}

module.exports = {
  UNLOCK_COOKIE_NAME,
  createUnlockToken,
  verifyUnlockToken,
  parseCookies,
  isUnlockedRequest,
  isCorrectAnniversaryDate,
};
