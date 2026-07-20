const test = require('node:test');
const assert = require('node:assert/strict');
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
