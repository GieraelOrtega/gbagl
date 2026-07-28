const test = require('node:test');
const assert = require('node:assert/strict');
const {
  JOURNAL_SYSTEM_ALBUM_KEY,
  ensureJournalPhotoSchema,
  ensureTimelinePhotoSchema,
  migrateAlbumsToJournal,
} = require('../db');

function migrationPool({
  albums = [],
  existingEntries = [],
  failOnPhotoUpdate = false,
  systemAlbumId = null,
} = {}) {
  const state = {
    began: 0,
    calls: [],
    committed: 0,
    released: 0,
    rolledBack: 0,
  };
  let nextJournalId = 100;
  const connection = {
    beginTransaction: async () => { state.began += 1; },
    commit: async () => { state.committed += 1; },
    rollback: async () => { state.rolledBack += 1; },
    release: () => { state.released += 1; },
    execute: async (sql, params = []) => {
      state.calls.push({ params, sql });
      if (sql.includes('WHERE system_key = ? FOR UPDATE')) {
        return [systemAlbumId ? [{ id: systemAlbumId }] : []];
      }
      if (sql.includes('MAX(display_order)') && sql.includes('photo_albums')) {
        return [[{ next_order: 4 }]];
      }
      if (sql.includes('INSERT INTO photo_albums')) return [{ insertId: 9 }];
      if (sql.includes('FROM photo_albums') && sql.includes('system_key IS NULL')) {
        return [albums];
      }
      if (sql.includes('FROM journal_entries') && sql.includes('source_album_id IS NOT NULL')) {
        return [existingEntries];
      }
      if (sql.includes('MAX(display_order)') && sql.includes('journal_entries')) {
        return [[{ max_order: 6 }]];
      }
      if (sql.includes('INSERT INTO journal_entries')) {
        nextJournalId += 1;
        return [{ insertId: nextJournalId }];
      }
      if (sql.includes('UPDATE album_photos')) {
        if (failOnPhotoUpdate) throw new Error('photo migration failed');
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  return {
    pool: { getConnection: async () => connection },
    state,
  };
}

test('album migration preserves existing moments and associates every legacy photo', async () => {
  const fake = migrationPool({
    albums: [
      { id: 1, title: 'First', description: 'One', entry_date: '2025-01-01' },
      { id: 2, title: 'Second', description: '', entry_date: '2025-02-01' },
    ],
    existingEntries: [{ id: 40, source_album_id: 1 }],
  });

  assert.equal(await migrateAlbumsToJournal(fake.pool), 9);
  const journalInserts = fake.state.calls.filter(
    (call) => call.sql.includes('INSERT INTO journal_entries'),
  );
  assert.equal(journalInserts.length, 1);
  assert.deepEqual(journalInserts[0].params, [
    2,
    'Second',
    '',
    '2025-02-01',
    7,
  ]);
  const photoUpdates = fake.state.calls.filter(
    (call) => call.sql.includes('UPDATE album_photos'),
  );
  assert.deepEqual(photoUpdates.map((call) => call.params), [
    [40, 1],
    [101, 2],
  ]);
  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.rolledBack, 0);
  assert.equal(fake.state.released, 1);
});

test('repeated album migration reuses the system album and creates no duplicate moments', async () => {
  const fake = migrationPool({
    albums: [
      { id: 1, title: 'First', description: 'One', entry_date: '2025-01-01' },
      { id: 2, title: 'Second', description: '', entry_date: '2025-02-01' },
    ],
    existingEntries: [
      { id: 40, source_album_id: 1 },
      { id: 41, source_album_id: 2 },
    ],
    systemAlbumId: 9,
  });

  assert.equal(await migrateAlbumsToJournal(fake.pool), 9);
  assert.equal(
    fake.state.calls.some((call) => call.sql.includes('INSERT INTO photo_albums')),
    false,
  );
  assert.equal(
    fake.state.calls.some((call) => call.sql.includes('INSERT INTO journal_entries')),
    false,
  );
  assert.equal(fake.state.committed, 1);
});

test('album migration rolls back and releases its connection on failure', async () => {
  const fake = migrationPool({
    albums: [
      { id: 1, title: 'First', description: 'One', entry_date: '2025-01-01' },
    ],
    failOnPhotoUpdate: true,
    systemAlbumId: 9,
  });

  await assert.rejects(migrateAlbumsToJournal(fake.pool), /photo migration failed/);
  assert.equal(fake.state.committed, 0);
  assert.equal(fake.state.rolledBack, 1);
  assert.equal(fake.state.released, 1);
});

test('Journal photo schema setup is idempotent for upgraded databases', async () => {
  const columns = new Set();
  const indexes = new Set();
  const foreignKeys = new Set();
  const altered = [];
  const pool = {
    execute: async (sql, params) => {
      const key = `${params[0]}:${params[1]}`;
      if (sql.includes('information_schema.COLUMNS')) return [columns.has(key) ? [{}] : []];
      if (sql.includes('information_schema.STATISTICS')) return [indexes.has(key) ? [{}] : []];
      if (sql.includes('information_schema.TABLE_CONSTRAINTS')) {
        return [foreignKeys.has(key) ? [{}] : []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    query: async (sql) => {
      altered.push(sql);
      const column = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
      const index = sql.match(/ALTER TABLE (\w+) ADD (?:UNIQUE )?INDEX (\w+)/);
      const foreignKey = sql.match(/ALTER TABLE (\w+) ADD CONSTRAINT (\w+)/);
      if (column) columns.add(`${column[1]}:${column[2]}`);
      if (index) indexes.add(`${index[1]}:${index[2]}`);
      if (foreignKey) foreignKeys.add(`${foreignKey[1]}:${foreignKey[2]}`);
      return [{}];
    },
  };

  await ensureJournalPhotoSchema(pool);
  assert.equal(columns.size, 3);
  assert.equal(indexes.size, 3);
  assert.equal(foreignKeys.size, 2);
  assert.equal(altered.length, 8);
  assert.ok(altered.some((sql) => sql.includes(JOURNAL_SYSTEM_ALBUM_KEY)) === false);

  await ensureJournalPhotoSchema(pool);
  assert.equal(altered.length, 8);
});

test('Timeline photo schema preserves legacy paths and is idempotent', async () => {
  const columns = new Set();
  const altered = [];
  let legacyUpdates = 0;
  const pool = {
    execute: async (sql, params = []) => {
      if (sql.includes('information_schema.COLUMNS')) {
        return [columns.has(`${params[0]}:${params[1]}`) ? [{}] : []];
      }
      if (sql.includes("SET photo_storage_type = 'existing'")) {
        legacyUpdates += 1;
        return [{ affectedRows: 3 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    query: async (sql) => {
      altered.push(sql);
      const column = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
      if (column) columns.add(`${column[1]}:${column[2]}`);
      return [{}];
    },
  };

  await ensureTimelinePhotoSchema(pool);
  assert.deepEqual([...columns].sort(), [
    'timeline_milestones:photo_media_type',
    'timeline_milestones:photo_storage_type',
  ]);
  assert.equal(altered.length, 2);
  assert.match(altered[0], /ENUM\('upload', 'existing'\)/);
  assert.equal(legacyUpdates, 1);

  await ensureTimelinePhotoSchema(pool);
  assert.equal(altered.length, 2);
  assert.equal(legacyUpdates, 2);
});
