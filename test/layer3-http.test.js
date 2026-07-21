const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createApp } = require('../server');

function firstCookie(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

test('PWA shell is public while private snapshots and exports keep both auth boundaries', async (t) => {
  const config = {
    accountCookieHours: 12,
    accounts: [
      {
        username: 'gierael',
        displayName: 'Gierael',
        role: 'admin',
        password: 'local-gierael-passphrase',
      },
      {
        username: 'kim',
        displayName: 'Kim',
        role: 'member',
        password: 'local-kim-passphrase',
      },
    ],
    backupDir: 'runtime/backups-layer3-test',
    backupIntervalHours: 24,
    backupMediaPaths: [],
    backupRetention: 7,
    cookieSecret: 'local-cookie-secret-for-layer-three-tests',
    port: 0,
    production: false,
    publicDir: require('path').join(__dirname, '..', 'public'),
    sitePasscode: '8462',
    uploadDir: 'runtime/uploads-layer3-test',
    uploadMaxBytes: 1024,
  };
  const unavailable = Object.assign(new Error('offline'), { code: 'DB_UNAVAILABLE' });
  const { app } = createApp(config, {
    backupService: {
      create: async () => ({ filename: 'unused.zip' }),
      downloadPath: () => { throw new Error('not found'); },
      list: async () => [],
    },
    exportService: {
      createPdf: async () => { throw unavailable; },
      createZip: async () => { throw unavailable; },
    },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(config.uploadDir, { force: true, recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const publicPath of [
    '/manifest.webmanifest',
    '/service-worker.js',
    '/offline.html',
    '/icons/icon-192.png',
    '/js/pwa.js',
  ]) {
    const response = await fetch(`${base}${publicPath}`);
    assert.equal(response.status, 200, `${publicPath} should be public`);
  }
  for (const privatePath of ['/js/main.js', '/reminders/feed.json', '/settings/exports']) {
    const response = await fetch(`${base}${privatePath}`, { redirect: 'manual' });
    assert.equal(response.status, 401, `${privatePath} should remain locked`);
    assert.equal(response.headers.get('x-gbagl-authorization-lost'), '1');
  }

  const locked = await fetch(`${base}/`);
  const csrfCookie = firstCookie(locked);
  const csrfToken = csrfFrom(await locked.text());
  const unlock = await fetch(`${base}/unlock`, {
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
  const siteCookie = firstCookie(unlock);
  const siteCookies = `${csrfCookie}; ${siteCookie}`;

  const snapshot = await fetch(`${base}/`, {
    headers: {
      Cookie: siteCookies,
      'X-GBAGL-Offline-Snapshot': '1',
    },
  });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers.get('x-gbagl-private-cache'), null);
  assert.equal(snapshot.headers.get('set-cookie'), null);
  const snapshotHtml = await snapshot.text();
  assert.doesNotMatch(snapshotHtml, /name="_csrf"|<form/i);
  assert.match(snapshotHtml, /Offline · read-only copies/);

  const siteOnlyExport = await fetch(`${base}/settings/exports`, {
    redirect: 'manual',
    headers: { Cookie: siteCookies },
  });
  assert.equal(siteOnlyExport.status, 303);
  assert.equal(siteOnlyExport.headers.get('location'), '/settings/login');

  const loginPage = await fetch(`${base}/settings/login`, { headers: { Cookie: siteCookies } });
  const adminToken = csrfFrom(await loginPage.text());
  const login = await fetch(`${base}/settings/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: siteCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: adminToken,
      username: config.accounts[0].username,
      password: config.accounts[0].password,
    }),
  });
  const accountCookie = firstCookie(login);
  const accountCookies = `${siteCookies}; ${accountCookie}`;
  const exportsPage = await fetch(`${base}/settings/exports`, {
    headers: { Cookie: accountCookies },
  });
  assert.equal(exportsPage.status, 200);
  assert.match(await exportsPage.text(), /Keepsake Exports/);

  const unavailableExport = await fetch(`${base}/settings/exports/keepsake.pdf`, {
    headers: { Cookie: accountCookies },
  });
  assert.equal(unavailableExport.status, 503);
  assert.match(unavailableExport.headers.get('cache-control'), /no-store/);
  assert.equal(unavailableExport.headers.get('x-content-type-options'), 'nosniff');

  const relock = await fetch(`${base}/lock`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: accountCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ _csrf: csrfToken }),
  });
  assert.equal(relock.status, 303);
  assert.equal(relock.headers.get('clear-site-data'), '"cache", "storage"');
  assert.equal(relock.headers.get('x-gbagl-clear-private-data'), '1');
  assert.match(relock.headers.get('set-cookie'), /gbagl_unlocked=.*Max-Age=0/);
  assert.match(relock.headers.get('set-cookie'), /gbagl_account=.*Max-Age=0/);
});
