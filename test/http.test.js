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
    uploadDir: 'runtime/uploads-http-base-test',
    uploadMaxBytes: 1024,
  };
  const backupService = {
    create: async () => ({ filename: 'unused.zip' }),
    downloadPath: () => { throw new Error('not found'); },
    list: async () => [],
  };
  const { app } = createApp(config, { backupService });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await require('fs').promises.rm(config.uploadDir, { force: true, recursive: true });
  });
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
  for (const adminPath of ['/admin/bucket', '/admin/events', '/admin/albums', '/admin/journals']) {
    const page = await fetch(`${base}${adminPath}`, {
      headers: { Cookie: `${siteCookies}; ${adminCookie}` },
    });
    assert.equal(page.status, 200, `${adminPath} should render for an admin`);
    assert.match(await page.text(), /database is unavailable/i);
  }

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

test('Layer 2 pages stay locked, degrade explicitly, and keep admin and CSRF boundaries', async (t) => {
  const config = {
    adminCookieHours: 12,
    adminPassword: 'local-admin-passphrase',
    backupDir: 'runtime/backups-test',
    backupIntervalHours: 24,
    backupMediaPaths: [],
    backupRetention: 7,
    cookieSecret: 'local-cookie-secret-for-layer-two-tests',
    port: 0,
    production: false,
    sitePasscode: '8462',
    uploadDir: 'runtime/uploads-http-test',
    uploadMaxBytes: 1024,
  };
  const backupService = {
    create: async () => ({ filename: 'unused.zip' }),
    downloadPath: () => { throw new Error('not found'); },
    list: async () => [],
  };
  const { app } = createApp(config, { backupService });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await require('fs').promises.rm(config.uploadDir, { force: true, recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const lockedForm = new FormData();
  lockedForm.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]), 'photo.jpg');
  const lockedUpload = await fetch(`${base}/admin/albums/photos/upload`, {
    method: 'POST',
    headers: { Accept: 'text/html' },
    body: lockedForm,
  });
  assert.equal(lockedUpload.status, 401);
  assert.match(await lockedUpload.text(), /Enter Passcode/);

  const lockedAlbum = await fetch(`${base}/albums`, { redirect: 'manual' });
  assert.equal(lockedAlbum.status, 401);
  const csrfCookie = firstCookie(lockedAlbum);
  const csrfToken = csrfFrom(await lockedAlbum.text());

  const unlock = await fetch(`${base}/unlock`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: csrfCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      passcode: config.sitePasscode,
      next: '/bucket',
    }),
  });
  const siteCookie = firstCookie(unlock);
  const cookies = `${csrfCookie}; ${siteCookie}`;

  for (const sitePath of ['/', '/bucket', '/reminders', '/albums', '/journal', '/timeline']) {
    const page = await fetch(`${base}${sitePath}`, { headers: { Cookie: cookies } });
    assert.equal(page.status, 200, `${sitePath} should render after site unlock`);
    assert.match(await page.text(), /unavailable|offline/i);
  }

  const feed = await fetch(`${base}/reminders/feed.json`, {
    headers: { Cookie: cookies },
  });
  assert.equal(feed.status, 503);
  assert.match(feed.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await feed.json(), { error: 'Reminders are unavailable' });

  const adminBoundary = await fetch(`${base}/admin/bucket`, {
    redirect: 'manual',
    headers: { Cookie: cookies },
  });
  assert.equal(adminBoundary.status, 303);
  assert.equal(adminBoundary.headers.get('location'), '/admin/login');

  const csrfBoundary = await fetch(`${base}/bucket/1/favorite`, {
    method: 'POST',
    headers: {
      Cookie: cookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(),
  });
  assert.equal(csrfBoundary.status, 403);

  const loginPage = await fetch(`${base}/admin/login`, { headers: { Cookie: cookies } });
  const loginToken = csrfFrom(await loginPage.text());
  const login = await fetch(`${base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: cookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: loginToken,
      password: config.adminPassword,
    }),
  });
  const adminCookie = firstCookie(login);
  const form = new FormData();
  form.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]), 'photo.jpg');
  const rejectedUpload = await fetch(`${base}/admin/albums/photos/upload`, {
    method: 'POST',
    headers: { Cookie: `${cookies}; ${adminCookie}` },
    body: form,
  });
  assert.equal(rejectedUpload.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await require('fs').promises.readdir(config.uploadDir), []);

  const invalidForm = new FormData();
  invalidForm.append('_csrf', 'invalid-token');
  invalidForm.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]), 'photo.jpg');
  const invalidUpload = await fetch(`${base}/admin/albums/photos/upload`, {
    method: 'POST',
    headers: { Cookie: `${cookies}; ${adminCookie}` },
    body: invalidForm,
  });
  assert.equal(invalidUpload.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await require('fs').promises.readdir(config.uploadDir), []);
});
