const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPoolOptions } = require('../db');
const { createApp } = require('../server');

function testConfig() {
  return {
    adminCookieHours: 12,
    adminPassword: 'local-admin-passphrase',
    backupDir: 'runtime/backups-runtime-test',
    backupIntervalHours: 24,
    backupMediaPaths: [],
    backupRetention: 7,
    cookieSecret: 'local-cookie-secret-for-runtime-tests',
    port: 0,
    production: false,
    sitePasscode: '8462',
    uploadDir: 'runtime/uploads-runtime-test',
    uploadMaxBytes: 1024,
  };
}

function backupService() {
  return {
    create: async () => ({ filename: 'unused.zip' }),
    downloadPath: () => { throw new Error('not found'); },
    list: async () => [],
  };
}

function firstCookie(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'response should contain a CSRF token');
  return match[1];
}

test('DB_SOCKET selects the Unix socket and omits TCP options', () => {
  const options = buildPoolOptions({
    DB_SOCKET: '  /srv/run/mysqld/mysqld.sock  ',
    DB_HOST: 'database.example',
    DB_PORT: '4406',
    DB_USER: 'app',
    DB_PASSWORD: 'secret',
    DB_NAME: 'app_db',
  });

  assert.equal(options.socketPath, '/srv/run/mysqld/mysqld.sock');
  assert.equal('host' in options, false);
  assert.equal('port' in options, false);
  assert.equal(options.user, 'app');
  assert.equal(options.password, 'secret');
  assert.equal(options.database, 'app_db');
  assert.equal(options.enableKeepAlive, true);
  assert.equal(options.connectionLimit, 10);
});

test('database options preserve TCP fallback when DB_SOCKET is absent', () => {
  const options = buildPoolOptions({
    DB_HOST: 'database.example',
    DB_PORT: '4406',
    DB_USER: 'app',
    DB_PASSWORD: 'secret',
    DB_NAME: 'app_db',
  });

  assert.equal('socketPath' in options, false);
  assert.equal(options.host, 'database.example');
  assert.equal(options.port, 4406);
});

test('blank DB_SOCKET uses TCP settings', () => {
  const options = buildPoolOptions({
    DB_SOCKET: '   ',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3307',
  });

  assert.equal('socketPath' in options, false);
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 3307);
});

test('createApp trusts only loopback and private proxy networks', () => {
  const { app } = createApp(testConfig(), { backupService: backupService() });
  const trustProxy = app.get('trust proxy fn');

  assert.equal(trustProxy('127.0.0.1', 0), true);
  assert.equal(trustProxy('169.254.10.20', 0), true);
  assert.equal(trustProxy('10.20.30.40', 0), true);
  assert.equal(trustProxy('fc00::1', 0), true);
  assert.equal(trustProxy('8.8.8.8', 0), false);
});

test('rate limiter accepts X-Forwarded-For from the local reverse proxy', async (t) => {
  const config = testConfig();
  const { app } = createApp(config, { backupService: backupService() });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await require('fs').promises.rm(config.uploadDir, { force: true, recursive: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const locked = await fetch(`${base}/`);
  const csrfCookie = firstCookie(locked);
  const csrfToken = csrfFrom(await locked.text());
  const validationErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    if (args.some((value) => String(value).includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'))) {
      validationErrors.push(args);
    }
  };
  t.after(() => {
    console.error = originalConsoleError;
  });

  const response = await fetch(`${base}/unlock`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: csrfCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-For': '203.0.113.50',
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      next: '/',
      passcode: 'wrong',
    }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(validationErrors, []);
});
