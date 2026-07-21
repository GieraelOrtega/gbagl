const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HOME_PHOTO_NAME_KEY,
  HOME_PHOTO_TYPE_KEY,
  replaceHomePhoto,
} = require('../routes/index');

function fakePool({ failWrite = false, previous = null } = {}) {
  const state = {
    began: 0,
    committed: 0,
    released: 0,
    rolledBack: 0,
    values: null,
  };
  const connection = {
    beginTransaction: async () => { state.began += 1; },
    commit: async () => { state.committed += 1; },
    rollback: async () => { state.rolledBack += 1; },
    release: () => { state.released += 1; },
    execute: async (sql, params) => {
      assert.match(sql, /FOR UPDATE/);
      assert.deepEqual(params, [HOME_PHOTO_NAME_KEY, HOME_PHOTO_TYPE_KEY]);
      return [previous ? [{
        setting_key: HOME_PHOTO_NAME_KEY,
        setting_value: previous,
      }] : []];
    },
    query: async (sql, values) => {
      if (failWrite) throw new Error('database write failed');
      assert.match(sql, /ON DUPLICATE KEY UPDATE/);
      state.values = values;
      return [{ affectedRows: 2 }];
    },
  };
  return {
    state,
    pool: { getConnection: async () => connection },
  };
}

test('home photo replacement commits metadata then removes the previous upload', async () => {
  const previous = '11111111111111111111111111111111.jpg';
  const current = '22222222222222222222222222222222.png';
  const fake = fakePool({ previous });
  const removed = [];
  const result = await replaceHomePhoto({
    databasePool: fake.pool,
    file: { path: 'temporary' },
    uploadDir: 'runtime/uploads',
    inspectUpload: async () => ({ mediaType: 'image/png', storageName: current }),
    removeStoredUpload: async (uploadDir, storageName) => {
      removed.push({ uploadDir, storageName });
    },
  });
  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.rolledBack, 0);
  assert.equal(fake.state.released, 1);
  assert.deepEqual(fake.state.values, [[
    [HOME_PHOTO_NAME_KEY, current],
    [HOME_PHOTO_TYPE_KEY, 'image/png'],
  ]]);
  assert.deepEqual(removed, [{ uploadDir: 'runtime/uploads', storageName: previous }]);
  assert.equal(result.cleanupError, null);
  assert.equal(result.storageName, current);
});

test('home photo replacement rolls back and removes a new file after database failure', async () => {
  const current = '22222222222222222222222222222222.png';
  const fake = fakePool({ failWrite: true });
  const removed = [];
  await assert.rejects(
    replaceHomePhoto({
      databasePool: fake.pool,
      file: { path: 'temporary' },
      uploadDir: 'runtime/uploads',
      inspectUpload: async () => ({ mediaType: 'image/png', storageName: current }),
      removeStoredUpload: async (uploadDir, storageName) => {
        removed.push({ uploadDir, storageName });
      },
    }),
    /database write failed/,
  );
  assert.equal(fake.state.committed, 0);
  assert.equal(fake.state.rolledBack, 1);
  assert.equal(fake.state.released, 1);
  assert.deepEqual(removed, [{ uploadDir: 'runtime/uploads', storageName: current }]);
});
