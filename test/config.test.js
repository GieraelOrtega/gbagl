const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');

test('configuration requires developer-provided authentication values', () => {
  assert.throws(() => loadConfig({}), /SITE_PASSCODE is required/);
  assert.throws(
    () => loadConfig({ SITE_PASSCODE: '8462' }),
    /COOKIE_SECRET is required/,
  );
  assert.throws(
    () => loadConfig({ SITE_PASSCODE: '8462', COOKIE_SECRET: 'abcdefghijklmnop' }),
    /ADMIN_PASSWORD is required/,
  );
});

test('production rejects weak or shared credentials', () => {
  const base = {
    NODE_ENV: 'production',
    SITE_PASSCODE: '8462',
    COOKIE_SECRET: '0123456789abcdefghijklmnopqrstuvwxyz',
    ADMIN_PASSWORD: 'correct-horse-battery-staple',
  };
  assert.equal(loadConfig(base).production, true);
  assert.throws(
    () => loadConfig({ ...base, ADMIN_PASSWORD: 'password-password' }),
    /too weak/,
  );
  assert.throws(
    () => loadConfig({ ...base, ADMIN_PASSWORD: base.SITE_PASSCODE }),
    /at least 12 characters|must be different/,
  );
});

test('backup storage cannot be placed under public static files', () => {
  assert.throws(() => loadConfig({
    SITE_PASSCODE: '8462',
    COOKIE_SECRET: 'abcdefghijklmnop',
    ADMIN_PASSWORD: 'local-admin',
    BACKUP_DIR: 'public/backups',
  }), /outside public/);
});
