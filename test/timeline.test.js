const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TIMELINE_IMPORT_MARKER,
  importTimelineOnce,
} = require('../db');
const { loadMilestones } = require('../routes/timeline');

function createFakePool(initialMilestones = []) {
  const state = {
    marker: null,
    milestones: [...initialMilestones],
  };
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    execute: async (sql, params = []) => {
      if (sql.includes('INSERT IGNORE INTO site_settings')) {
        if (state.marker === null) state.marker = 'pending';
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SELECT setting_value FROM site_settings')) {
        assert.equal(params[0], TIMELINE_IMPORT_MARKER);
        return [[{ setting_value: state.marker }]];
      }
      if (sql.includes('SELECT COUNT(*) AS count FROM timeline_milestones')) {
        return [[{ count: state.milestones.length }]];
      }
      if (sql.includes('INSERT INTO timeline_milestones')) {
        state.milestones.push({
          displayOrder: params[0],
          date: params[1],
          title: params[2],
          description: params[3],
          emoji: params[4],
          photo: params[5],
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET setting_value = 'complete'")) {
        assert.equal(params[0], TIMELINE_IMPORT_MARKER);
        state.marker = 'complete';
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

test('timeline imports once and an intentional empty timeline stays empty', async () => {
  const source = [{
    date: 'Private deployment date',
    title: 'Private deployment title',
    description: 'Private deployment description',
    emoji: 'X',
    photo: 'images/private.jpg',
  }];
  const fake = createFakePool();

  assert.equal(await importTimelineOnce(fake.pool, source), true);
  assert.deepEqual(fake.state.milestones[0], {
    displayOrder: 0,
    date: source[0].date,
    title: source[0].title,
    description: source[0].description,
    emoji: source[0].emoji,
    photo: source[0].photo,
  });
  assert.equal(fake.state.marker, 'complete');

  fake.state.milestones = [];
  assert.equal(await importTimelineOnce(fake.pool, source), false);
  assert.deepEqual(fake.state.milestones, []);
});

test('existing deployment rows are marked migrated without being overwritten', async () => {
  const existing = [{ title: 'Existing private row' }];
  const fake = createFakePool(existing);
  assert.equal(await importTimelineOnce(fake.pool, [{ title: 'Public fallback' }]), false);
  assert.deepEqual(fake.state.milestones, existing);
  assert.equal(fake.state.marker, 'complete');
});

test('successful empty timeline query is authoritative while query errors fall back', async () => {
  const fallback = [{ title: 'File fallback' }];
  assert.deepEqual(await loadMilestones({
    databaseAvailable: () => true,
    databasePool: () => ({ execute: async () => [[]] }),
    fallback,
  }), []);

  assert.deepEqual(await loadMilestones({
    databaseAvailable: () => true,
    databasePool: () => ({ execute: async () => { throw new Error('offline'); } }),
    fallback,
  }), fallback);
});
