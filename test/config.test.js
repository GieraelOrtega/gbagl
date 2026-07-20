const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_BACKUP_INTERVAL_HOURS, loadConfig } = require('../config');

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

test('site passcode must match the four-digit lock UI', () => {
  const base = {
    COOKIE_SECRET: 'abcdefghijklmnop',
    ADMIN_PASSWORD: 'local-admin',
  };
  assert.equal(loadConfig({ ...base, SITE_PASSCODE: '0123' }).sitePasscode, '0123');
  for (const invalid of ['123', '12345', 'abcd', '12 3']) {
    assert.throws(
      () => loadConfig({ ...base, SITE_PASSCODE: invalid }),
      /exactly four digits/,
    );
  }
});

test('backup interval accepts the timer boundary and rejects overflow', () => {
  const base = {
    SITE_PASSCODE: '8462',
    COOKIE_SECRET: 'abcdefghijklmnop',
    ADMIN_PASSWORD: 'local-admin',
  };
  assert.equal(loadConfig({
    ...base,
    BACKUP_INTERVAL_HOURS: String(MAX_BACKUP_INTERVAL_HOURS),
  }).backupIntervalHours, MAX_BACKUP_INTERVAL_HOURS);
  assert.throws(() => loadConfig({
    ...base,
    BACKUP_INTERVAL_HOURS: String(MAX_BACKUP_INTERVAL_HOURS + 1),
  }), new RegExp(`must not exceed ${MAX_BACKUP_INTERVAL_HOURS}`));
  assert.throws(() => loadConfig({
    ...base,
    BACKUP_INTERVAL_HOURS: '24hours',
  }), /must be a positive integer/);
});

test('backup media and output directories cannot overlap in either direction', () => {
  const base = {
    SITE_PASSCODE: '8462',
    COOKIE_SECRET: 'abcdefghijklmnop',
    ADMIN_PASSWORD: 'local-admin',
  };
  assert.throws(() => loadConfig({
    ...base,
    BACKUP_DIR: 'runtime/backups',
    BACKUP_MEDIA_PATHS: 'runtime',
  }), /must not contain or be contained by BACKUP_DIR/);
  assert.throws(() => loadConfig({
    ...base,
    BACKUP_DIR: 'runtime',
    BACKUP_MEDIA_PATHS: 'runtime/uploads',
  }), /must not contain or be contained by BACKUP_DIR/);
  assert.doesNotThrow(() => loadConfig({
    ...base,
    BACKUP_DIR: 'runtime/backups',
    BACKUP_MEDIA_PATHS: 'runtime/uploads',
  }));
});
