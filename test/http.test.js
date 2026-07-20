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

function testConfig(suffix) {
  return {
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
    backupDir: `runtime/backups-${suffix}`,
    backupIntervalHours: 24,
    backupMediaPaths: [],
    backupRetention: 7,
    cookieSecret: `local-cookie-secret-for-${suffix}`,
    port: 0,
    production: false,
    sitePasscode: '8462',
    uploadDir: `runtime/uploads-${suffix}`,
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

async function signIn(base, cookies, csrfToken, account) {
  return fetch(`${base}/settings/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: cookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      username: account.username,
      password: account.password,
    }),
  });
}

test('viewer, Kim member, and Gierael administrator boundaries are enforced', async (t) => {
  const config = testConfig('http-roles-test');
  const { app } = createApp(config, { backupService: backupService() });
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
  assert.match(locked.headers.get('content-security-policy'), /object-src 'none'/);
  assert.match(locked.headers.get('permissions-policy'), /camera=\(\)/);
  const lockedHtml = await locked.text();
  assert.match(lockedHtml, />Install Now</);
  assert.doesNotMatch(lockedHtml, />Online</);
  const csrfCookie = firstCookie(locked);
  const csrfToken = csrfFrom(lockedHtml);

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
  const siteCookies = `${csrfCookie}; ${siteCookie}`;

  const viewerAdventure = await fetch(`${base}/adventure`, {
    headers: { Cookie: siteCookies },
  });
  const viewerAdventureHtml = await viewerAdventure.text();
  assert.match(viewerAdventureHtml, /View-only mode/);
  assert.doesNotMatch(viewerAdventureHtml, /<form action="\/adventure"/);

  const viewerWrite = await fetch(`${base}/bucket/1/favorite`, {
    method: 'POST',
    headers: {
      Cookie: siteCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ _csrf: csrfToken }),
  });
  assert.equal(viewerWrite.status, 403);

  const contentBoundary = await fetch(`${base}/settings/content/bucket`, {
    redirect: 'manual',
    headers: { Cookie: siteCookies },
  });
  assert.equal(contentBoundary.status, 303);
  assert.equal(contentBoundary.headers.get('location'), '/settings/login');

  const loginPage = await fetch(`${base}/settings/login`, {
    headers: { Cookie: siteCookies },
  });
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Sign in to make changes/);

  const gieraelLogin = await signIn(base, siteCookies, csrfToken, config.accounts[0]);
  assert.equal(gieraelLogin.status, 303);
  const gieraelCookie = firstCookie(gieraelLogin);
  const gieraelCookies = `${siteCookies}; ${gieraelCookie}`;
  const adminSettings = await fetch(`${base}/settings`, {
    headers: { Cookie: gieraelCookies },
  });
  const adminHtml = await adminSettings.text();
  assert.equal(adminSettings.status, 200);
  assert.match(adminHtml, /Settings/);
  assert.match(adminHtml, /Administrator/);
  assert.match(adminHtml, /id="site-settings"/);

  for (const contentPath of [
    '/settings/content/bucket',
    '/settings/content/events',
    '/settings/content/albums',
    '/settings/content/journals',
  ]) {
    const page = await fetch(`${base}${contentPath}`, {
      headers: { Cookie: gieraelCookies },
    });
    assert.equal(page.status, 200, `${contentPath} should render for Gierael`);
    assert.match(await page.text(), /database is unavailable/i);
  }

  const kimLogin = await signIn(base, siteCookies, csrfToken, config.accounts[1]);
  assert.equal(kimLogin.status, 303);
  const kimCookie = firstCookie(kimLogin);
  const kimCookies = `${siteCookies}; ${kimCookie}`;
  const memberSettings = await fetch(`${base}/settings`, {
    headers: { Cookie: kimCookies },
  });
  const memberHtml = await memberSettings.text();
  assert.equal(memberSettings.status, 200);
  assert.match(memberHtml, /Member/);
  assert.doesNotMatch(memberHtml, /id="site-settings"/);
  assert.doesNotMatch(memberHtml, /Create backup now/);

  const memberContent = await fetch(`${base}/settings/content/albums`, {
    headers: { Cookie: kimCookies },
  });
  assert.equal(memberContent.status, 200);
  const memberWrite = await fetch(`${base}/adventure`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: kimCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      vibe: 'cozy',
      budget: '$',
      location: 'at home',
      notes: 'Member-authorized write',
    }),
  });
  assert.notEqual(memberWrite.status, 403);
  const memberExport = await fetch(`${base}/settings/exports`, {
    redirect: 'manual',
    headers: { Cookie: kimCookies },
  });
  assert.equal(memberExport.status, 403);
  const memberSiteWrite = await fetch(`${base}/settings/site`, {
    method: 'POST',
    headers: {
      Cookie: kimCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ _csrf: csrfToken }),
  });
  assert.equal(memberSiteWrite.status, 403);

  const csrfFailure = await fetch(`${base}/lock`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: kimCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(),
  });
  assert.equal(csrfFailure.status, 403);

  const relocked = await fetch(`${base}/lock`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: kimCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ _csrf: csrfToken }),
  });
  assert.equal(relocked.status, 303);
  const cleared = relocked.headers.get('set-cookie');
  assert.match(cleared, /gbagl_unlocked=.*Max-Age=0/);
  assert.match(cleared, /gbagl_account=.*Max-Age=0/);
});

test('private pages degrade explicitly and upload ingress keeps auth and CSRF boundaries', async (t) => {
  const config = testConfig('http-upload-test');
  const { app } = createApp(config, { backupService: backupService() });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await require('fs').promises.rm(config.uploadDir, { force: true, recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const lockedForm = new FormData();
  lockedForm.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]), 'photo.jpg');
  const lockedUpload = await fetch(`${base}/settings/content/albums/photos/upload`, {
    method: 'POST',
    headers: { Accept: 'text/html' },
    body: lockedForm,
  });
  assert.equal(lockedUpload.status, 401);
  assert.match(await lockedUpload.text(), /Enter Passcode/);

  const lockedAlbum = await fetch(`${base}/albums`, { redirect: 'manual' });
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
  const siteCookies = `${csrfCookie}; ${siteCookie}`;

  for (const sitePath of ['/', '/bucket', '/reminders', '/albums', '/journal', '/timeline']) {
    const page = await fetch(`${base}${sitePath}`, { headers: { Cookie: siteCookies } });
    assert.equal(page.status, 200, `${sitePath} should render after site unlock`);
    assert.match(await page.text(), /unavailable|offline/i);
  }

  const feed = await fetch(`${base}/reminders/feed.json`, {
    headers: { Cookie: siteCookies },
  });
  assert.equal(feed.status, 503);
  assert.match(feed.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await feed.json(), { error: 'Reminders are unavailable' });

  const login = await signIn(base, siteCookies, csrfToken, config.accounts[0]);
  const accountCookie = firstCookie(login);
  const accountCookies = `${siteCookies}; ${accountCookie}`;

  const rejectedForm = new FormData();
  rejectedForm.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]), 'photo.jpg');
  const rejectedUpload = await fetch(`${base}/settings/content/albums/photos/upload`, {
    method: 'POST',
    headers: { Cookie: accountCookies },
    body: rejectedForm,
  });
  assert.equal(rejectedUpload.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await require('fs').promises.readdir(config.uploadDir), []);

  const invalidForm = new FormData();
  invalidForm.append('_csrf', 'invalid-token');
  invalidForm.append('photo', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])]), 'photo.jpg');
  const invalidUpload = await fetch(`${base}/settings/content/albums/photos/upload`, {
    method: 'POST',
    headers: { Cookie: accountCookies },
    body: invalidForm,
  });
  assert.equal(invalidUpload.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await require('fs').promises.readdir(config.uploadDir), []);
});
