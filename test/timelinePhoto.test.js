const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  createTimelineMilestone,
  createTimelineRouter,
  deleteTimelineMilestone,
  updateTimelineMilestone,
} = require('../routes/timeline');
const { timelinePhotoDetails } = require('../lib/timelinePhoto');

const VALID_MILESTONE = Object.freeze({
  date: 'Summer 2026',
  description: 'A day worth remembering',
  emoji: 'X',
  link_url: '',
  title: 'Our day',
});

function fakePool(respond, overrides = {}) {
  const state = {
    began: 0,
    calls: [],
    committed: 0,
    released: 0,
    rolledBack: 0,
  };
  const connection = {
    beginTransaction: async () => { state.began += 1; },
    commit: async () => {
      if (overrides.commit) return overrides.commit(state);
      state.committed += 1;
    },
    rollback: async () => {
      if (overrides.rollback) return overrides.rollback(state);
      state.rolledBack += 1;
    },
    release: () => { state.released += 1; },
    execute: async (sql, params = []) => {
      state.calls.push({ params, sql });
      return respond(sql, params);
    },
  };
  return {
    pool: {
      execute: connection.execute,
      getConnection: async () => connection,
    },
    state,
  };
}

test('Timeline creation stores an optional upload in the milestone transaction', async () => {
  const fake = fakePool((sql) => {
    if (sql.includes('MAX(display_order)')) return [[{ next_order: 4 }]];
    if (sql.includes('INSERT INTO timeline_milestones')) return [{ insertId: 12 }];
    throw new Error(`Unexpected query: ${sql}`);
  });
  const storageName = `${'a'.repeat(32)}.png`;

  const id = await createTimelineMilestone({
    body: VALID_MILESTONE,
    databasePool: fake.pool,
    file: { path: 'temporary' },
    inspectUpload: async () => ({ mediaType: 'image/png', storageName }),
    uploadDir: 'uploads',
  });

  const insert = fake.state.calls.find(
    (call) => call.sql.includes('INSERT INTO timeline_milestones'),
  );
  assert.equal(id, 12);
  assert.deepEqual(insert.params, [
    4,
    'Summer 2026',
    'Our day',
    'A day worth remembering',
    'X',
    storageName,
    'upload',
    'image/png',
    null,
  ]);
  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.rolledBack, 0);
  assert.equal(fake.state.released, 1);
});

test('Timeline creation without a photo keeps photo metadata empty', async () => {
  const fake = fakePool((sql) => {
    if (sql.includes('MAX(display_order)')) return [[{ next_order: 0 }]];
    if (sql.includes('INSERT INTO timeline_milestones')) return [{ insertId: 3 }];
    throw new Error(`Unexpected query: ${sql}`);
  });

  await createTimelineMilestone({
    body: VALID_MILESTONE,
    databasePool: fake.pool,
    file: null,
    uploadDir: 'uploads',
  });

  const insert = fake.state.calls.find(
    (call) => call.sql.includes('INSERT INTO timeline_milestones'),
  );
  assert.deepEqual(insert.params.slice(5, 8), [null, null, null]);
});

test('failed Timeline creation rolls back and removes only the new upload', async () => {
  const removed = [];
  const storageName = `${'b'.repeat(32)}.jpg`;
  const fake = fakePool((sql) => {
    if (sql.includes('MAX(display_order)')) return [[{ next_order: 1 }]];
    if (sql.includes('INSERT INTO timeline_milestones')) throw new Error('insert failed');
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(
    createTimelineMilestone({
      body: VALID_MILESTONE,
      databasePool: fake.pool,
      file: { path: 'temporary' },
      inspectUpload: async () => ({ mediaType: 'image/jpeg', storageName }),
      removeStoredUpload: async (...args) => removed.push(args),
      uploadDir: 'uploads',
    }),
    /insert failed/,
  );

  assert.equal(fake.state.committed, 0);
  assert.equal(fake.state.rolledBack, 1);
  assert.equal(fake.state.released, 1);
  assert.deepEqual(removed, [['uploads', storageName]]);
});

test('an ambiguous successful Timeline create is verified before file cleanup', async () => {
  const removed = [];
  const storageName = `${'7'.repeat(32)}.jpg`;
  const fake = fakePool((sql) => {
    if (sql.includes('MAX(display_order)')) return [[{ next_order: 1 }]];
    if (sql.includes('INSERT INTO timeline_milestones')) return [{ insertId: 13 }];
    if (sql.includes('milestone_date AS date')) {
      return [[{
        date: 'Summer 2026',
        description: 'A day worth remembering',
        emoji: 'X',
        linkUrl: null,
        photo: storageName,
        photo_media_type: 'image/jpeg',
        photo_storage_type: 'upload',
        title: 'Our day',
      }]];
    }
    throw new Error(`Unexpected query: ${sql}`);
  }, {
    commit: async (state) => {
      state.committed += 1;
      throw new Error('commit response lost');
    },
  });

  const id = await createTimelineMilestone({
    body: VALID_MILESTONE,
    databasePool: fake.pool,
    file: { path: 'temporary' },
    inspectUpload: async () => ({ mediaType: 'image/jpeg', storageName }),
    removeStoredUpload: async (...args) => removed.push(args),
    uploadDir: 'uploads',
  });

  assert.equal(id, 13);
  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.rolledBack, 0);
  assert.deepEqual(removed, []);
});

test('an unverifiable create commit preserves its new upload', async () => {
  const removed = [];
  const storageName = `${'8'.repeat(32)}.png`;
  const fake = fakePool((sql) => {
    if (sql.includes('MAX(display_order)')) return [[{ next_order: 1 }]];
    if (sql.includes('INSERT INTO timeline_milestones')) return [{ insertId: 14 }];
    if (sql.includes('milestone_date AS date')) throw new Error('database unavailable');
    throw new Error(`Unexpected query: ${sql}`);
  }, {
    commit: async () => { throw new Error('commit response lost'); },
  });

  await assert.rejects(
    createTimelineMilestone({
      body: VALID_MILESTONE,
      databasePool: fake.pool,
      file: { path: 'temporary' },
      inspectUpload: async () => ({ mediaType: 'image/png', storageName }),
      removeStoredUpload: async (...args) => removed.push(args),
      uploadDir: 'uploads',
    }),
    /save status could not be confirmed/,
  );

  assert.equal(fake.state.rolledBack, 1);
  assert.deepEqual(removed, []);
});

test('a failed rollback preserves a possibly referenced new upload', async () => {
  const removed = [];
  const storageName = `${'9'.repeat(32)}.webp`;
  const fake = fakePool((sql) => {
    if (sql.includes('MAX(display_order)')) return [[{ next_order: 1 }]];
    if (sql.includes('INSERT INTO timeline_milestones')) throw new Error('write response lost');
    throw new Error(`Unexpected query: ${sql}`);
  }, {
    rollback: async (state) => {
      state.rolledBack += 1;
      throw new Error('rollback response lost');
    },
  });

  await assert.rejects(
    createTimelineMilestone({
      body: VALID_MILESTONE,
      databasePool: fake.pool,
      file: { path: 'temporary' },
      inspectUpload: async () => ({ mediaType: 'image/webp', storageName }),
      removeStoredUpload: async (...args) => removed.push(args),
      uploadDir: 'uploads',
    }),
    /write response lost/,
  );

  assert.equal(fake.state.rolledBack, 1);
  assert.deepEqual(removed, []);
});

test('Timeline replacement commits before cleaning the previous uploaded file', async () => {
  const previous = `${'c'.repeat(32)}.jpg`;
  const replacement = `${'d'.repeat(32)}.webp`;
  const fake = fakePool((sql) => {
    if (sql.includes('SELECT photo, photo_storage_type')) {
      return [[{
        photo: previous,
        photo_media_type: 'image/jpeg',
        photo_storage_type: 'upload',
      }]];
    }
    if (sql.includes('UPDATE timeline_milestones')) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  });
  const removed = [];

  const result = await updateTimelineMilestone({
    body: VALID_MILESTONE,
    databasePool: fake.pool,
    file: { path: 'temporary' },
    id: 7,
    inspectUpload: async () => ({
      mediaType: 'image/webp',
      storageName: replacement,
    }),
    removeStoredUpload: async (...args) => {
      assert.equal(fake.state.committed, 1);
      removed.push(args);
    },
    uploadDir: 'uploads',
  });

  const update = fake.state.calls.find(
    (call) => call.sql.includes('UPDATE timeline_milestones'),
  );
  assert.deepEqual(update.params.slice(4, 7), [
    replacement,
    'upload',
    'image/webp',
  ]);
  assert.deepEqual(removed, [['uploads', previous]]);
  assert.deepEqual(result, { cleanupErrors: [], id: 7 });
});

test('an ambiguous committed Timeline replacement keeps the new file and cleans the old one', async () => {
  const previous = `${'a'.repeat(32)}.jpg`;
  const replacement = `${'b'.repeat(32)}.png`;
  const removed = [];
  const fake = fakePool((sql) => {
    if (sql.includes('FOR UPDATE')) {
      return [[{
        photo: previous,
        photo_media_type: 'image/jpeg',
        photo_storage_type: 'upload',
      }]];
    }
    if (sql.includes('UPDATE timeline_milestones')) return [{ affectedRows: 1 }];
    if (sql.includes('milestone_date AS date')) {
      return [[{
        photo: replacement,
        photo_media_type: 'image/png',
        photo_storage_type: 'upload',
      }]];
    }
    throw new Error(`Unexpected query: ${sql}`);
  }, {
    commit: async (state) => {
      state.committed += 1;
      throw new Error('commit response lost');
    },
  });

  const result = await updateTimelineMilestone({
    body: VALID_MILESTONE,
    databasePool: fake.pool,
    file: { path: 'temporary' },
    id: 15,
    inspectUpload: async () => ({
      mediaType: 'image/png',
      storageName: replacement,
    }),
    removeStoredUpload: async (...args) => removed.push(args),
    uploadDir: 'uploads',
  });

  assert.deepEqual(result, { cleanupErrors: [], id: 15 });
  assert.deepEqual(removed, [['uploads', previous]]);
});

test('Timeline replacement never deletes a deployment-local current photo', async () => {
  const replacement = `${'e'.repeat(32)}.png`;
  const fake = fakePool((sql) => {
    if (sql.includes('SELECT photo, photo_storage_type')) {
      return [[{
        photo: 'images/deployment-only.jpg',
        photo_media_type: null,
        photo_storage_type: 'existing',
      }]];
    }
    if (sql.includes('UPDATE timeline_milestones')) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  });
  const removed = [];

  await updateTimelineMilestone({
    body: VALID_MILESTONE,
    databasePool: fake.pool,
    file: { path: 'temporary' },
    id: 8,
    inspectUpload: async () => ({ mediaType: 'image/png', storageName: replacement }),
    removeStoredUpload: async (...args) => removed.push(args),
    uploadDir: 'uploads',
  });

  assert.deepEqual(removed, []);
  assert.equal(fake.state.committed, 1);
});

test('explicit Timeline photo removal cleans uploads but preserves deployment files', async () => {
  for (const current of [
    {
      expectedRemovals: [[`uploads`, `${'f'.repeat(32)}.jpg`]],
      photo: `${'f'.repeat(32)}.jpg`,
      photo_media_type: 'image/jpeg',
      photo_storage_type: 'upload',
    },
    {
      expectedRemovals: [],
      photo: 'images/deployment-only.png',
      photo_media_type: null,
      photo_storage_type: 'existing',
    },
  ]) {
    const removed = [];
    const fake = fakePool((sql) => {
      if (sql.includes('SELECT photo, photo_storage_type')) return [[current]];
      if (sql.includes('UPDATE timeline_milestones')) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const result = await updateTimelineMilestone({
      body: { ...VALID_MILESTONE, remove_photo: '1' },
      databasePool: fake.pool,
      file: null,
      id: 9,
      removeStoredUpload: async (...args) => removed.push(args),
      uploadDir: 'uploads',
    });
    const update = fake.state.calls.find(
      (call) => call.sql.includes('UPDATE timeline_milestones'),
    );
    assert.deepEqual(update.params.slice(4, 7), [null, null, null]);
    assert.deepEqual(removed, current.expectedRemovals);
    assert.deepEqual(result.cleanupErrors, []);
  }
});

test('failed Timeline replacement rolls back, removes the new upload, and keeps the old one', async () => {
  const previous = `${'1'.repeat(32)}.jpg`;
  const replacement = `${'2'.repeat(32)}.png`;
  const removed = [];
  const fake = fakePool((sql) => {
    if (sql.includes('SELECT photo, photo_storage_type')) {
      return [[{
        photo: previous,
        photo_media_type: 'image/jpeg',
        photo_storage_type: 'upload',
      }]];
    }
    if (sql.includes('UPDATE timeline_milestones')) throw new Error('update failed');
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(
    updateTimelineMilestone({
      body: VALID_MILESTONE,
      databasePool: fake.pool,
      file: { path: 'temporary' },
      id: 10,
      inspectUpload: async () => ({ mediaType: 'image/png', storageName: replacement }),
      removeStoredUpload: async (...args) => removed.push(args),
      uploadDir: 'uploads',
    }),
    /update failed/,
  );

  assert.equal(fake.state.committed, 0);
  assert.equal(fake.state.rolledBack, 1);
  assert.deepEqual(removed, [['uploads', replacement]]);
});

test('committed Timeline cleanup failures are surfaced without rolling back the update', async () => {
  const fake = fakePool((sql) => {
    if (sql.includes('SELECT photo, photo_storage_type')) {
      return [[{
        photo: `${'3'.repeat(32)}.jpg`,
        photo_media_type: 'image/jpeg',
        photo_storage_type: 'upload',
      }]];
    }
    if (sql.includes('UPDATE timeline_milestones')) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await updateTimelineMilestone({
    body: { ...VALID_MILESTONE, remove_photo: '1' },
    databasePool: fake.pool,
    file: null,
    id: 11,
    removeStoredUpload: async () => { throw new Error('disk unavailable'); },
    uploadDir: 'uploads',
  });

  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.rolledBack, 0);
  assert.equal(result.cleanupErrors.length, 1);
  assert.match(result.cleanupErrors[0].message, /disk unavailable/);
});

test('Timeline deletion cleans uploaded photos only after commit', async () => {
  for (const current of [
    {
      expected: [`uploads`, `${'4'.repeat(32)}.webp`],
      photo: `${'4'.repeat(32)}.webp`,
      photo_storage_type: 'upload',
    },
    {
      expected: null,
      photo: 'images/deployment-only.webp',
      photo_storage_type: 'existing',
    },
  ]) {
    let removed = null;
    const fake = fakePool((sql) => {
      if (sql.includes('SELECT photo, photo_storage_type')) return [[current]];
      if (sql.includes('DELETE FROM timeline_milestones')) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const result = await deleteTimelineMilestone({
      databasePool: fake.pool,
      id: 12,
      removeStoredUpload: async (...args) => {
        assert.equal(fake.state.committed, 1);
        removed = args;
      },
      uploadDir: 'uploads',
    });
    assert.deepEqual(removed, current.expected);
    assert.deepEqual(result.cleanupErrors, []);
  }
});

test('Timeline photo resolution rejects inconsistent upload metadata', () => {
  assert.throws(
    () => timelinePhotoDetails(
      { uploadDir: 'uploads' },
      {
        photo: `${'5'.repeat(32)}.png`,
        photo_media_type: 'image/jpeg',
        photo_storage_type: 'upload',
      },
    ),
    /does not match/,
  );
  assert.throws(
    () => timelinePhotoDetails(
      { publicDir: 'public' },
      { photo: '../secret.jpg', photo_storage_type: 'existing' },
    ),
    /Image path/,
  );
});

test('protected Timeline response serves uploads and old deployment photos with private headers', async (t) => {
  const root = path.join(
    __dirname,
    '..',
    'runtime',
    `timeline-protected-test-${process.pid}-${Date.now()}`,
  );
  const uploadDir = path.join(root, 'uploads');
  const publicDir = path.join(root, 'public');
  await fs.promises.mkdir(path.join(publicDir, 'images'), { recursive: true });
  await fs.promises.mkdir(uploadDir, { recursive: true });
  const uploadName = `${'6'.repeat(32)}.jpg`;
  await fs.promises.writeFile(
    path.join(uploadDir, uploadName),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  );
  await fs.promises.writeFile(
    path.join(publicDir, 'images', 'legacy.png'),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const pool = {
    execute: async (sql, params) => {
      assert.match(sql, /FROM timeline_milestones/);
      if (params[0] === 1) {
        return [[{
          photo: uploadName,
          photo_media_type: 'image/jpeg',
          photo_storage_type: 'upload',
        }]];
      }
      if (params[0] === 2) {
        return [[{
          photo: 'images/legacy.png',
          photo_media_type: null,
          photo_storage_type: 'existing',
        }]];
      }
      return [[]];
    },
  };
  const app = express();
  app.use('/timeline', createTimelineRouter(
    { publicDir, uploadDir },
    {
      getPool: () => pool,
      isDbAvailable: () => true,
    },
  ));
  app.use((req, res) => res.status(404).end());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(root, { force: true, recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const [id, mediaType] of [[1, 'image/jpeg'], [2, 'image/png']]) {
    const response = await fetch(`${base}/timeline/photos/${id}/content`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mediaType);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-gbagl-private-cache'), 'media-v1');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.equal(
    (await fetch(`${base}/timeline/photos/3/content`)).status,
    404,
  );
});
