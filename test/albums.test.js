const test = require('node:test');
const assert = require('node:assert/strict');
const { updatePhotoDetails } = require('../routes/albums');

function photoPool({ failUpdate = false } = {}) {
  const state = {
    began: 0,
    committed: 0,
    released: 0,
    rolledBack: 0,
    calls: [],
  };
  const connection = {
    beginTransaction: async () => { state.began += 1; },
    commit: async () => { state.committed += 1; },
    rollback: async () => { state.rolledBack += 1; },
    release: () => { state.released += 1; },
    execute: async (sql, params) => {
      state.calls.push({ sql, params });
      if (sql.includes('SELECT album_id')) {
        return [[{ album_id: 1, display_order: 2 }]];
      }
      if (sql.includes('SELECT id FROM photo_albums')) {
        return [[{ id: 1 }, { id: 2 }]];
      }
      if (sql.includes('SELECT display_order FROM album_photos')) {
        return [[{ display_order: 4 }]];
      }
      if (failUpdate && /SET album_id/.test(sql)) throw new Error('update failed');
      return [{ affectedRows: 1 }];
    },
  };
  return {
    state,
    pool: { getConnection: async () => connection },
  };
}

const photo = {
  albumId: 2,
  milestoneId: 7,
  caption: 'Moved memory',
  photoDate: '2026-03-01',
};

test('moving a photo appends it without disturbing source-album ordering', async () => {
  const fake = photoPool();
  const result = await updatePhotoDetails(fake.pool, '9', photo);
  const update = fake.state.calls.find((call) => /SET album_id/.test(call.sql));
  assert.equal(
    fake.state.calls.some((call) => /display_order = display_order - 1/.test(call.sql)),
    false,
  );
  assert.deepEqual(update.params, [2, 7, 'Moved memory', '2026-03-01', 5, 9]);
  assert.deepEqual(result, { albumId: 2, moved: true });
  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.rolledBack, 0);
  assert.equal(fake.state.released, 1);
});

test('photo moves roll back their ordering changes when the update fails', async () => {
  const fake = photoPool({ failUpdate: true });
  await assert.rejects(updatePhotoDetails(fake.pool, 9, photo), /update failed/);
  assert.equal(fake.state.committed, 0);
  assert.equal(fake.state.rolledBack, 1);
  assert.equal(fake.state.released, 1);
});
