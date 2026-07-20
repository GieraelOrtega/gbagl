const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSignedValue,
  safeEqual,
  verifySignedValue,
} = require('../lib/cookies');
const { createAdminAuth } = require('../middleware/adminAuth');
const { createPasscodeAuth } = require('../middleware/passcode');

const config = {
  adminCookieHours: 12,
  adminPassword: 'local-admin-passphrase',
  cookieSecret: 'local-cookie-secret-for-test-use',
  production: false,
  sitePasscode: '8462',
};

test('signed values reject tampering and timing-safe comparison handles lengths', () => {
  const signed = createSignedValue('payload', config.cookieSecret);
  assert.equal(verifySignedValue(signed, config.cookieSecret), 'payload');
  assert.equal(verifySignedValue(`${signed}x`, config.cookieSecret), null);
  assert.equal(safeEqual('same', 'same'), true);
  assert.equal(safeEqual('short', 'longer'), false);
});

test('site unlock does not imply admin access', () => {
  const passcode = createPasscodeAuth(config);
  const admin = createAdminAuth(config);
  const headers = {};
  passcode.setUnlockCookie({
    getHeader: (name) => headers[name],
    setHeader: (name, value) => { headers[name] = value; },
  });
  const request = { headers: { cookie: headers['Set-Cookie'].split(';')[0] } };
  assert.equal(passcode.isUnlocked(request), true);
  assert.equal(admin.isAdmin(request), false);
  assert.equal(admin.isValidPassword(config.adminPassword), true);
  assert.equal(admin.isValidPassword('wrong-passphrase'), false);
});
