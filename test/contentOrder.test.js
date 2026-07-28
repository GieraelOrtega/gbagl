const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nextDisplayOrder,
  orderedIds,
  publicOrderError,
  reorderCollection,
} = require('../lib/contentOrder');
const { ensureContentOrderingSchema } = require('../db');

function reorderPool(existingRows) {
  const state = {
    began: 0,
    committed: 0,
    released: 0,
    rolledBack: 0,
    updates: [],
  };
  const connection = {
    beginTransaction: async () => { state.began += 1; },
    commit: async () => { state.committed += 1; },
    rollback: async () => { state.rolledBack += 1; },
    release: () => { state.released += 1; },
    execute: async (sql, params = []) => {
      if (sql.includes('SELECT id FROM')) return [existingRows];
      if (sql.includes('SET display_order')) {
        state.updates.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return {
    state,
    pool: { getConnection: async () => connection },
  };
}

test('ordered IDs reject malformed and duplicate sequences without an artificial item cap', () => {
  assert.deepEqual(orderedIds(['3', '1', '2']), [3, 1, 2]);
  assert.throws(() => orderedIds('1,2'), /Order must be a list/);
  assert.throws(() => orderedIds(['1', '1']), /duplicate/);
  assert.throws(() => orderedIds(['0']), /invalid item/);
  assert.equal(
    orderedIds(Array.from({ length: 501 }, (_, index) => index + 1)).length,
    501,
  );
});

test('reorder responses disclose client errors without exposing database failures', () => {
  const stale = new Error('Content changed while reordering. Refresh and try again.');
  stale.statusCode = 409;
  assert.deepEqual(publicOrderError(stale), {
    status: 409,
    message: stale.message,
  });
  assert.deepEqual(publicOrderError(new Error('mysql connection details')), {
    status: 500,
    message: 'Order could not be saved',
  });
});

test('reordering validates the complete collection and commits sequential positions', async () => {
  const fake = reorderPool([{ id: 1 }, { id: 2 }, { id: 3 }]);
  await reorderCollection(fake.pool, 'bucket', ['3', '1', '2']);
  assert.equal(fake.state.began, 1);
  assert.equal(fake.state.committed, 1);
  assert.equal(fake.state.rolledBack, 0);
  assert.equal(fake.state.released, 1);
  assert.deepEqual(
    fake.state.updates.map((update) => update.params),
    [[0, 3], [1, 1], [2, 2]],
  );
});

test('photo ordering is scoped to one album and stale sequences roll back', async () => {
  const scoped = reorderPool([{ id: 8 }, { id: 9 }]);
  await reorderCollection(scoped.pool, 'photos', ['9', '8'], '4');
  assert.match(scoped.state.updates[0].sql, /album_id = \?/);
  assert.deepEqual(scoped.state.updates[0].params, [0, 9, 4]);

  const stale = reorderPool([{ id: 1 }, { id: 2 }]);
  await assert.rejects(
    reorderCollection(stale.pool, 'journal', ['1']),
    /Content changed while reordering/,
  );
  assert.equal(stale.state.committed, 0);
  assert.equal(stale.state.rolledBack, 1);
  assert.equal(stale.state.released, 1);
});

test('new content appends after the current maximum order', async () => {
  const calls = [];
  const pool = {
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return [[{ next_order: 7 }]];
    },
  };
  assert.equal(await nextDisplayOrder(pool, 'photos', 3), 7);
  assert.match(calls[0].sql, /album_id = \?/);
  assert.deepEqual(calls[0].params, [3]);
});

test('ordering schema migration adds only missing columns and indexes', async () => {
  const changes = [];
  const missingPool = {
    execute: async () => [[]],
    query: async (sql) => { changes.push(sql); return [{}]; },
  };
  await ensureContentOrderingSchema(missingPool);
  assert.equal(changes.filter((sql) => /ADD COLUMN display_order/.test(sql)).length, 4);
  assert.equal(changes.filter((sql) => /ADD INDEX/.test(sql)).length, 4);
  assert.ok(changes.every((sql) => (
    /date_ideas|bucket_items|shared_events|journal_entries/.test(sql)
  )));

  let existingChanges = 0;
  await ensureContentOrderingSchema({
    execute: async () => [[{ present: 1 }]],
    query: async () => { existingChanges += 1; return [{}]; },
  });
  assert.equal(existingChanges, 0);
});

test('ordering schema migration tolerates only concurrent duplicate DDL', async () => {
  let changes = 0;
  await ensureContentOrderingSchema({
    execute: async () => [[]],
    query: async (sql) => {
      changes += 1;
      const error = new Error('already exists');
      if (/ADD COLUMN/.test(sql)) error.code = 'ER_DUP_FIELDNAME';
      else error.errno = 1061;
      throw error;
    },
  });
  assert.equal(changes, 8);

  await assert.rejects(
    ensureContentOrderingSchema({
      execute: async () => [[]],
      query: async () => {
        const error = new Error('permission denied');
        error.code = 'ER_TABLEACCESS_DENIED_ERROR';
        throw error;
      },
    }),
    /permission denied/,
  );
});
