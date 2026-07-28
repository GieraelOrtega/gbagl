const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addJournalPhoto,
  createJournalEntry,
  deleteJournalEntry,
  deleteJournalPhoto,
  updateJournalEntry,
} = require('../routes/journal');

function fakePool(respond) {
  const state = {
    began: 0,
    calls: [],
    committed: 0,
    released: 0,
    rolledBack: 0,
  };
  const connection = {
    beginTransaction: async () => { state.began += 1; },
    commit: async () => { state.committed += 1; },
    rollback: async () => { state.rolledBack += 1; },
    release: () => { state.released += 1; },
    execute: async (sql, params = []) => {
      state.calls.push({ params, sql });
      return respond(sql, params);
    },
  };
  return {
    pool: { getConnection: async () => connection },
    state,
  };
}

const validEntry = {
  body: 'A lovely day',
  entry_date: '2026-08-01',
  milestone_id: '',
  photo_caption: 'Together',
  title: 'Our moment',
};

test('Journal moments can be created without a photo', async () => {
  const fake = fakePool((sql) => {
    if (sql.includes('MAX(display_order)')) return [[{ next_order: 3 }]];
    if (sql.includes('INSERT INTO journal_entries')) {
      return [{ affectedRows: 1, insertId: 11 }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const entryId = await createJournalEntry({
    body: validEntry,
    databasePool: fake.pool,
    file: null,
    uploadDir: 'unused',
  });

  assert.equal(entryId, 11);
  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.rolledBack, 0);
  assert.equal(fake.state.released, 1);
  assert.equal(
    fake.state.calls.some((call) => call.sql.includes('INSERT INTO album_photos')),
    false,
  );
});

test('Journal creation commits its optional protected photo in one transaction', async () => {
  const fake = fakePool((sql) => {
    if (sql.includes('MAX(display_order)') && sql.includes('journal_entries')) {
      return [[{ next_order: 3 }]];
    }
    if (sql.includes('INSERT INTO journal_entries')) return [{ insertId: 11 }];
    if (sql.includes('SELECT id FROM journal_entries')) return [[{ id: 11 }]];
    if (sql.includes('MAX(display_order)') && sql.includes('album_photos')) {
      return [[{ next_order: 0 }]];
    }
    if (sql.includes('FROM photo_albums')) return [[{ id: 9 }]];
    if (sql.includes('INSERT INTO album_photos')) {
      return [{ affectedRows: 1, insertId: 21 }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const entryId = await createJournalEntry({
    body: validEntry,
    databasePool: fake.pool,
    file: { path: 'temporary' },
    inspectUpload: async () => ({
      mediaType: 'image/jpeg',
      storageName: 'a'.repeat(32) + '.jpg',
    }),
    uploadDir: 'uploads',
  });

  const photoInsert = fake.state.calls.find(
    (call) => call.sql.includes('INSERT INTO album_photos'),
  );
  assert.equal(entryId, 11);
  assert.deepEqual(photoInsert.params, [
    9,
    11,
    null,
    'Together',
    '2026-08-01',
    0,
    'a'.repeat(32) + '.jpg',
    'image/jpeg',
  ]);
  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.released, 1);
});

test('editing a Journal moment preserves each attached photo date and milestone', async () => {
  const fake = fakePool((sql) => {
    if (sql.includes('UPDATE journal_entries')) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  });

  assert.equal(await updateJournalEntry(fake.pool, 11, validEntry), 11);
  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.rolledBack, 0);
  assert.equal(
    fake.state.calls.some((call) => call.sql.includes('UPDATE album_photos')),
    false,
  );
});

test('failed Journal creation rolls back and removes the stored upload', async () => {
  const removed = [];
  const fake = fakePool((sql) => {
    if (sql.includes('MAX(display_order)')) return [[{ next_order: 0 }]];
    if (sql.includes('INSERT INTO journal_entries')) throw new Error('insert failed');
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(
    createJournalEntry({
      body: validEntry,
      databasePool: fake.pool,
      file: { path: 'temporary' },
      inspectUpload: async () => ({
        mediaType: 'image/jpeg',
        storageName: 'b'.repeat(32) + '.jpg',
      }),
      removeStoredUpload: async (...args) => removed.push(args),
      uploadDir: 'uploads',
    }),
    /insert failed/,
  );

  assert.equal(fake.state.committed, 0);
  assert.equal(fake.state.rolledBack, 1);
  assert.equal(fake.state.released, 1);
  assert.deepEqual(removed, [['uploads', 'b'.repeat(32) + '.jpg']]);
});

test('photo upload to a missing Journal moment rolls back and removes the upload', async () => {
  const removed = [];
  const fake = fakePool((sql) => {
    if (sql.includes('FROM journal_entries')) return [[]];
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(
    addJournalPhoto({
      body: { photo_caption: 'Unattached' },
      databasePool: fake.pool,
      entryId: 7,
      file: { path: 'temporary' },
      inspectUpload: async () => ({
        mediaType: 'image/png',
        storageName: 'c'.repeat(32) + '.png',
      }),
      removeStoredUpload: async (...args) => removed.push(args),
      uploadDir: 'uploads',
    }),
    /Journal entry not found/,
  );

  assert.equal(fake.state.rolledBack, 1);
  assert.deepEqual(removed, [['uploads', 'c'.repeat(32) + '.png']]);
});

test('photo deletion commits database removal before reporting file cleanup failure', async () => {
  const fake = fakePool((sql) => {
    if (sql.includes('SELECT storage_type')) {
      return [[{ storage_name: 'd'.repeat(32) + '.jpg', storage_type: 'upload' }]];
    }
    if (sql.includes('DELETE FROM album_photos')) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await deleteJournalPhoto({
    databasePool: fake.pool,
    entryId: 3,
    photoId: 4,
    removeStoredUpload: async () => { throw new Error('disk unavailable'); },
    uploadDir: 'uploads',
  });

  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.rolledBack, 0);
  assert.equal(result.entryId, 3);
  assert.equal(result.cleanupErrors.length, 1);
  assert.match(result.cleanupErrors[0].message, /disk unavailable/);
});

test('deleting a migrated Journal moment removes its legacy album and uploaded files', async () => {
  const removed = [];
  const fake = fakePool((sql) => {
    if (sql.includes('SELECT source_album_id')) return [[{ source_album_id: 8 }]];
    if (sql.includes('SELECT DISTINCT storage_name')) {
      return [[
        { storage_name: 'e'.repeat(32) + '.jpg' },
        { storage_name: 'f'.repeat(32) + '.png' },
      ]];
    }
    if (sql.includes('DELETE FROM')) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await deleteJournalEntry({
    databasePool: fake.pool,
    entryId: 3,
    removeStoredUpload: async (...args) => removed.push(args),
    uploadDir: 'uploads',
  });

  assert.equal(fake.state.committed, 1);
  assert.equal(result.cleanupErrors.length, 0);
  assert.deepEqual(removed, [
    ['uploads', 'e'.repeat(32) + '.jpg'],
    ['uploads', 'f'.repeat(32) + '.png'],
  ]);
  assert.ok(fake.state.calls.some(
    (call) => call.sql.includes('DELETE FROM photo_albums'),
  ));
});
