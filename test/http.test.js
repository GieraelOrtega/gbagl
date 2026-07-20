const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

function firstCookie(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'response should contain a CSRF token');
  return match[1];
}

test('lock, separate admin login, CSRF failure, and logout flow', async (t) => {
  const config = {
    adminCookieHours: 12,
    adminPassword: 'local-admin-passphrase',
    backupDir: 'runtime/backups-test',
    backupIntervalHours: 24,
    backupMediaPaths: [],
    backupRetention: 7,
    cookieSecret: 'local-cookie-secret-for-http-tests',
    port: 0,
    production: false,
    sitePasscode: '8462',
  };
  const backupService = {
    create: async () => ({ filename: 'unused.zip' }),
    downloadPath: () => { throw new Error('not found'); },
    list: async () => [],
  };
  const { app } = createApp(config, { backupService });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const locked = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(locked.status, 401);
  assert.match(locked.headers.get('cache-control'), /no-store/);
  assert.equal(locked.headers.get('x-robots-tag'), 'noindex, nofollow');
  const csrfCookie = firstCookie(locked);
  const csrfToken = csrfFrom(await locked.text());

  const unlocked = await fetch(`${base}/unlock`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: csrfCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      next: '/',
      passcode: config.sitePasscode,
    }),
  });
  assert.equal(unlocked.status, 303);
  const siteCookie = firstCookie(unlocked);

  const csrfFailure = await fetch(`${base}/lock`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: siteCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(),
  });
  assert.equal(csrfFailure.status, 403);

  const siteCookies = `${csrfCookie}; ${siteCookie}`;
  const adminLogin = await fetch(`${base}/admin/login`, {
    headers: { Cookie: siteCookies },
  });
  assert.equal(adminLogin.status, 200);
  const adminToken = csrfFrom(await adminLogin.text());

  const adminAuthenticated = await fetch(`${base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: siteCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: adminToken,
      password: config.adminPassword,
    }),
  });
  assert.equal(adminAuthenticated.status, 303);
  const adminCookie = firstCookie(adminAuthenticated);

  const dashboard = await fetch(`${base}/admin`, {
    headers: { Cookie: `${siteCookies}; ${adminCookie}` },
  });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Admin Dashboard/);

  const relocked = await fetch(`${base}/lock`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: `${siteCookies}; ${adminCookie}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ _csrf: csrfToken }),
  });
  assert.equal(relocked.status, 303);
  const cleared = relocked.headers.get('set-cookie');
  assert.match(cleared, /gbagl_unlocked=.*Max-Age=0/);
  assert.match(cleared, /gbagl_admin=.*Max-Age=0/);
});
