const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_BACKUP_INTERVAL_HOURS,
  MAX_UPLOAD_BYTES,
  loadConfig,
} = require('../config');

const LOCAL_AUTH = Object.freeze({
  SITE_PASSCODE: '8462',
  COOKIE_SECRET: 'abcdefghijklmnop',
  GIERAEL_PASSWORD: 'local-gierael-passphrase',
  KIM_PASSWORD: 'local-kim-passphrase',
});

test('configuration requires the viewer and both account credentials', () => {
  assert.throws(() => loadConfig({}), /SITE_PASSCODE is required/);
  assert.throws(
    () => loadConfig({ SITE_PASSCODE: '8462' }),
    /COOKIE_SECRET is required/,
  );
  assert.throws(
    () => loadConfig({
      SITE_PASSCODE: '8462',
      COOKIE_SECRET: 'abcdefghijklmnop',
    }),
    /GIERAEL_PASSWORD is required/,
  );
  assert.throws(
    () => loadConfig({
      SITE_PASSCODE: '8462',
      COOKIE_SECRET: 'abcdefghijklmnop',
      GIERAEL_PASSWORD: 'local-gierael-passphrase',
    }),
    /KIM_PASSWORD is required/,
  );
});

test('configuration creates fixed Gierael admin and Kim member accounts', () => {
  const config = loadConfig(LOCAL_AUTH);
  assert.deepEqual(
    config.accounts.map(({ username, displayName, role }) => ({
      username,
      displayName,
      role,
    })),
    [
      { username: 'gierael', displayName: 'Gierael', role: 'admin' },
      { username: 'kim', displayName: 'Kim', role: 'member' },
    ],
  );
  assert.equal(config.accountCookieHours, 12);
  assert.deepEqual(config.trustProxy, ['loopback']);
});

test('legacy admin password remains an alias for the Gierael credential', () => {
  const { GIERAEL_PASSWORD, ...withoutGierael } = LOCAL_AUTH;
  const config = loadConfig({
    ...withoutGierael,
    ADMIN_PASSWORD: GIERAEL_PASSWORD,
  });
  assert.equal(config.accounts[0].password, GIERAEL_PASSWORD);
});

test('production rejects weak, reused, or shared credentials', () => {
  const base = {
    NODE_ENV: 'production',
    SITE_PASSCODE: '8462',
    COOKIE_SECRET: '0123456789abcdefghijklmnopqrstuvwxyz',
    GIERAEL_PASSWORD: 'correct-horse-battery-staple',
    KIM_PASSWORD: 'sunlit-river-copper-orchid',
  };
  assert.equal(loadConfig(base).production, true);
  assert.equal(loadConfig(base).publicOrigin, 'https://gba.gl');
  assert.throws(
    () => loadConfig({ ...base, GIERAEL_PASSWORD: 'password-password' }),
    /too weak/,
  );
  assert.throws(
    () => loadConfig({ ...base, KIM_PASSWORD: 'secret-secret-secret' }),
    /too weak/,
  );
  assert.throws(
    () => loadConfig({ ...base, KIM_PASSWORD: base.GIERAEL_PASSWORD }),
    /must be different/,
  );
  assert.throws(
    () => loadConfig({ ...base, GIERAEL_PASSWORD: base.SITE_PASSCODE }),
    /at least 12 characters|must be different/,
  );
  assert.throws(
    () => loadConfig({
      ...base,
      COOKIE_SECRET: 'violet-river-copper-orchid-cascade',
      GIERAEL_PASSWORD: 'violet-river-copper-orchid-cascade',
    }),
    /COOKIE_SECRET must be different/,
  );
  assert.throws(
    () => loadConfig({ ...base, PUBLIC_ORIGIN: 'http://gba.gl' }),
    /must use HTTPS/,
  );
  assert.throws(
    () => loadConfig({ ...base, PUBLIC_ORIGIN: 'https://gba.gl/private' }),
    /only a scheme and host/,
  );
  assert.deepEqual(
    loadConfig({ ...base, TRUST_PROXY: 'loopback, 10.0.0.12' }).trustProxy,
    ['loopback', '10.0.0.12'],
  );
  assert.throws(
    () => loadConfig({ ...base, TRUST_PROXY: 'uniquelocal' }),
    /exact proxy IP/,
  );
});

test('backup storage cannot be placed under public static files', () => {
  assert.throws(() => loadConfig({
    ...LOCAL_AUTH,
    BACKUP_DIR: 'public/backups',
  }), /outside public/);
  if (process.platform === 'win32') {
    assert.throws(() => loadConfig({
      ...LOCAL_AUTH,
      UPLOAD_DIR: 'PUBLIC/uploads',
    }), /outside public/);
  }
});

test('site passcode must match the four-digit lock UI', () => {
  assert.equal(loadConfig({ ...LOCAL_AUTH, SITE_PASSCODE: '0123' }).sitePasscode, '0123');
  for (const invalid of ['123', '12345', 'abcd', '12 3']) {
    assert.throws(
      () => loadConfig({ ...LOCAL_AUTH, SITE_PASSCODE: invalid }),
      /exactly four digits/,
    );
  }
});

test('backup interval accepts the timer boundary and rejects overflow', () => {
  assert.equal(loadConfig({
    ...LOCAL_AUTH,
    BACKUP_INTERVAL_HOURS: String(MAX_BACKUP_INTERVAL_HOURS),
  }).backupIntervalHours, MAX_BACKUP_INTERVAL_HOURS);
  assert.throws(() => loadConfig({
    ...LOCAL_AUTH,
    BACKUP_INTERVAL_HOURS: String(MAX_BACKUP_INTERVAL_HOURS + 1),
  }), new RegExp(`must not exceed ${MAX_BACKUP_INTERVAL_HOURS}`));
  assert.throws(() => loadConfig({
    ...LOCAL_AUTH,
    BACKUP_INTERVAL_HOURS: '24hours',
  }), /must be a positive integer/);
});

test('backup media and output directories cannot overlap in either direction', () => {
  assert.throws(() => loadConfig({
    ...LOCAL_AUTH,
    BACKUP_DIR: 'runtime/backups',
    BACKUP_MEDIA_PATHS: 'runtime',
  }), /must not contain or be contained by BACKUP_DIR/);
  assert.throws(() => loadConfig({
    ...LOCAL_AUTH,
    BACKUP_DIR: 'runtime',
    BACKUP_MEDIA_PATHS: 'runtime/uploads',
  }), /must not contain or be contained by BACKUP_DIR/);
  assert.doesNotThrow(() => loadConfig({
    ...LOCAL_AUTH,
    BACKUP_DIR: 'runtime/backups',
    BACKUP_MEDIA_PATHS: 'runtime/uploads',
  }));
});

test('custom upload directories are automatically covered by backup media paths', () => {
  const config = loadConfig({
    ...LOCAL_AUTH,
    UPLOAD_DIR: 'private-media/photos',
    BACKUP_MEDIA_PATHS: 'public/images',
  });

  assert.ok(config.backupMediaPaths.includes(config.uploadDir));
});

test('protected upload size remains strictly capped', () => {
  assert.equal(loadConfig(LOCAL_AUTH).uploadMaxBytes, 8 * 1024 * 1024);
  assert.throws(
    () => loadConfig({ ...LOCAL_AUTH, UPLOAD_MAX_BYTES: String(MAX_UPLOAD_BYTES + 1) }),
    /must not exceed/,
  );
});
