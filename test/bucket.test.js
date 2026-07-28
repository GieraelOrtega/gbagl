const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { toggleVote } = require('../repositories/bucket');

function fakePool(existingVote) {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push(['begin']),
    commit: async () => calls.push(['commit']),
    rollback: async () => calls.push(['rollback']),
    release: () => calls.push(['release']),
    execute: async (sql, params) => {
      calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
      if (sql.includes('SELECT vote')) {
        return [existingVote ? [{ vote: existingVote }] : []];
      }
      return [{ affectedRows: 1 }];
    },
  };
  return {
    calls,
    getConnection: async () => connection,
  };
}

test('a repeated bucket vote toggles off the unique slot/item record', async () => {
  const pool = fakePool('yes');
  assert.equal(await toggleVote(pool, 7, 'partner_one', 'yes'), null);
  assert.ok(pool.calls.some(([sql]) => String(sql).startsWith('DELETE FROM bucket_votes')));
  assert.ok(!pool.calls.some(([sql]) => String(sql).startsWith('INSERT INTO bucket_votes')));
});

test('a changed bucket vote upserts against the unique slot/item key', async () => {
  const pool = fakePool('maybe');
  assert.equal(await toggleVote(pool, 7, 'partner_one', 'yes'), 'yes');
  const upsert = pool.calls.find(([sql]) => String(sql).startsWith('INSERT INTO bucket_votes'));
  assert.deepEqual(upsert[1], [7, 'partner_one', 'yes']);
  assert.match(upsert[0], /ON DUPLICATE KEY UPDATE/);
});

function firstCookie(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'response should contain a CSRF token');
  return match[1];
}

function httpConfig() {
  return {
    accountCookieHours: 12,
    accounts: [{
      username: 'kim',
      displayName: 'Kim',
      role: 'member',
      password: 'local-kim-passphrase',
    }],
    backupDir: 'runtime/backups-bucket-http-test',
    backupIntervalHours: 24,
    backupMediaPaths: [],
    backupRetention: 7,
    cookieSecret: 'local-cookie-secret-for-bucket-http-test',
    port: 0,
    production: false,
    sitePasscode: '8462',
    uploadDir: 'runtime/uploads-bucket-http-test',
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

function bucketDatabase() {
  const state = {
    commits: 0,
    completionUpdates: [],
    orderUpdates: [],
    rollbacks: 0,
  };
  const items = [
    {
      id: 1,
      title: 'See the coast',
      description: 'Take the scenic route.',
      category: 'travel',
      target_date: '2026-09-01',
      display_order: 0,
      is_favorite: 1,
      completed_at: null,
      memory: null,
      partner_one_vote: 'yes',
      partner_two_vote: 'maybe',
    },
    {
      id: 2,
      title: 'Make pasta together',
      description: 'Flour everywhere.',
      category: 'food',
      target_date: null,
      display_order: 1,
      is_favorite: 0,
      completed_at: '2026-07-20',
      memory: 'It was delicious.',
      partner_one_vote: 'yes',
      partner_two_vote: 'yes',
    },
  ];
  const connection = {
    beginTransaction: async () => {},
    commit: async () => { state.commits += 1; },
    rollback: async () => { state.rollbacks += 1; },
    release: () => {},
    execute: async (sql, params = []) => {
      if (sql.includes('SELECT id FROM bucket_items')) {
        assert.match(sql, /WHERE completed_at IS NULL/);
        return [[{ id: 1 }]];
      }
      if (sql.includes('SET display_order')) {
        assert.match(sql, /AND completed_at IS NULL/);
        state.orderUpdates.push(params);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected transaction SQL: ${sql}`);
    },
  };
  const pool = {
    getConnection: async () => connection,
    execute: async (sql, params = []) => {
      if (sql.includes('FROM bucket_items i')) return [items];
      if (sql.includes('FROM site_settings')) {
        return [[
          { setting_key: 'partner_one_name', setting_value: 'Gierael' },
          { setting_key: 'partner_two_name', setting_value: 'Kim' },
          { setting_key: 'timezone', setting_value: 'America/Los_Angeles' },
        ]];
      }
      if (sql.includes('UPDATE bucket_items SET completed_at = ?')) {
        state.completionUpdates.push(params);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
  };
  return { pool, state };
}

test('Bucket List HTTP experience separates status and protects completion and reorder writes', async (t) => {
  const config = httpConfig();
  const database = bucketDatabase();
  const { app } = createApp(config, {
    backupService: backupService(),
    bucketDependencies: {
      currentDate: () => new Date('2026-07-28T02:03:17.426Z'),
      databaseAvailable: () => true,
      databasePool: () => database.pool,
    },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await require('fs').promises.rm(config.uploadDir, { force: true, recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const locked = await fetch(`${base}/bucket`);
  const lockedHtml = await locked.text();
  const csrfCookie = firstCookie(locked);
  const csrfToken = csrfFrom(lockedHtml);
  const unlock = await fetch(`${base}/unlock`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: csrfCookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      next: '/bucket',
      passcode: config.sitePasscode,
    }),
  });
  const siteCookies = `${csrfCookie}; ${firstCookie(unlock)}`;

  const viewerPage = await fetch(`${base}/bucket`, { headers: { Cookie: siteCookies } });
  const viewerHtml = await viewerPage.text();
  assert.equal(viewerPage.status, 200);
  assert.ok(viewerHtml.indexOf('Active Dreams') < viewerHtml.indexOf('Completed'));
  assert.match(viewerHtml, /It was delicious\./);
  assert.doesNotMatch(viewerHtml, /<form/);

  const offlinePage = await fetch(`${base}/bucket`, {
    headers: {
      Cookie: siteCookies,
      'X-GBAGL-Offline-Snapshot': '1',
    },
  });
  const offlineHtml = await offlinePage.text();
  assert.equal(offlinePage.headers.get('x-gbagl-private-cache'), 'read-only-v1');
  assert.match(offlineHtml, /<body data-offline-snapshot>/);
  assert.match(offlineHtml, /It was delicious\./);
  assert.doesNotMatch(offlineHtml, /<form|contentEditor\.js/);

  const viewerWrite = await fetch(`${base}/bucket/1/completion`, {
    method: 'POST',
    headers: {
      Cookie: siteCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      completed: '1',
      completed_at: '2026-07-27',
    }),
  });
  assert.equal(viewerWrite.status, 403);

  const login = await fetch(`${base}/settings/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: siteCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      username: config.accounts[0].username,
      password: config.accounts[0].password,
    }),
  });
  const memberCookies = `${siteCookies}; ${firstCookie(login)}`;
  const editorPage = await fetch(`${base}/bucket`, { headers: { Cookie: memberCookies } });
  const editorHtml = await editorPage.text();
  assert.match(editorHtml, /name="completed_at"[\s\S]*value="2026-07-27"/);
  for (const action of ['/favorite', '/vote', '/completion', '/memory', '/delete']) {
    assert.ok(editorHtml.includes(action), `Editor response missing ${action}`);
  }

  const missingCsrf = await fetch(`${base}/bucket/1/completion`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: memberCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ completed: '1', completed_at: '2026-07-27' }),
  });
  assert.equal(missingCsrf.status, 403);

  const missingDate = await fetch(`${base}/bucket/1/completion`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: memberCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ _csrf: csrfToken, completed: '1', completed_at: '' }),
  });
  assert.equal(missingDate.status, 303);
  assert.match(missingDate.headers.get('location'), /Completion\+date\+is\+required/);
  assert.deepEqual(database.state.completionUpdates, []);

  const completed = await fetch(`${base}/bucket/1/completion`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: memberCookies,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      _csrf: csrfToken,
      completed: '1',
      completed_at: '2026-07-27',
    }),
  });
  assert.equal(completed.status, 303);
  assert.deepEqual(database.state.completionUpdates, [['2026-07-27', 1]]);

  const reordered = await fetch(`${base}/bucket/reorder`, {
    method: 'POST',
    headers: {
      Cookie: memberCookies,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ _csrf: csrfToken, ids: ['1'] }),
  });
  assert.equal(reordered.status, 204);
  assert.deepEqual(database.state.orderUpdates, [[0, 1]]);

  const completedIncluded = await fetch(`${base}/bucket/reorder`, {
    method: 'POST',
    headers: {
      Cookie: memberCookies,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ _csrf: csrfToken, ids: ['1', '2'] }),
  });
  assert.equal(completedIncluded.status, 409);
  assert.equal(database.state.rollbacks, 1);
});
