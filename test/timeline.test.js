const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RELATIONSHIP_BASICS_MARKER,
  TIMELINE_IMPORT_MARKER,
  importTimelineOnce,
  seedRelationshipBasics,
} = require('../db');
const { loadMilestones, loadMilestonesResult } = require('../routes/timeline');

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

test('relationship basics run once so later cleared settings survive restarts', async () => {
  const state = {
    anniversary: '',
    marker: null,
    milestoneUpdates: 0,
  };
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    execute: async (sql, params = []) => {
      if (sql.includes('INSERT IGNORE INTO site_settings')) {
        assert.equal(params[0], RELATIONSHIP_BASICS_MARKER);
        if (state.marker === null) state.marker = 'pending';
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('SELECT setting_value FROM site_settings')) {
        assert.equal(params[0], RELATIONSHIP_BASICS_MARKER);
        return [[{ setting_value: state.marker }]];
      }
      if (sql.includes('CASE setting_key')) {
        if (state.anniversary === '') state.anniversary = '2025-12-08';
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE timeline_milestones')) {
        state.milestoneUpdates += 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET setting_value = 'complete'")) {
        state.marker = 'complete';
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const databasePool = { getConnection: async () => connection };

  assert.equal(await seedRelationshipBasics(databasePool), true);
  assert.equal(state.anniversary, '2025-12-08');
  assert.equal(state.milestoneUpdates, 1);

  state.anniversary = '';
  assert.equal(await seedRelationshipBasics(databasePool), false);
  assert.equal(state.anniversary, '');
  assert.equal(state.milestoneUpdates, 1);
});

test('complete migration marker makes an empty timeline authoritative', async () => {
  const fallback = [{ title: 'File fallback' }];
  assert.deepEqual(await loadMilestones({
    databaseAvailable: () => true,
    databasePool: () => ({
      execute: async (sql, params = []) => {
        if (sql.includes('FROM timeline_milestones')) return [[]];
        assert.equal(params[0], TIMELINE_IMPORT_MARKER);
        return [[{ setting_value: 'complete' }]];
      },
    }),
    fallback,
  }), []);
});

test('present database milestones return without consulting the migration marker', async () => {
  const rows = [{ title: 'Database milestone' }];
  let queryCount = 0;
  assert.deepEqual(await loadMilestones({
    databaseAvailable: () => true,
    databasePool: () => ({
      execute: async () => {
        queryCount += 1;
        return [rows];
      },
    }),
    fallback: [{ title: 'File fallback' }],
  }), rows);
  assert.equal(queryCount, 1);
});

test('absent or pending migration marker preserves file fallback for empty rows', async () => {
  const fallback = [{ title: 'Private file fallback' }];
  for (const markerRows of [[], [{ setting_value: 'pending' }]]) {
    assert.deepEqual(await loadMilestones({
      databaseAvailable: () => true,
      databasePool: () => ({
        execute: async (sql) => (
          sql.includes('FROM timeline_milestones') ? [[]] : [markerRows]
        ),
      }),
      fallback,
    }), fallback);
  }
});

test('timeline query errors use file fallback', async () => {
  const fallback = [{ title: 'File fallback' }];
  assert.deepEqual(await loadMilestones({
    databaseAvailable: () => true,
    databasePool: () => ({ execute: async () => { throw new Error('offline'); } }),
    fallback,
  }), fallback);
});

test('timeline fallback is marked degraded so it cannot replace an offline snapshot', async () => {
  const fallback = [{ title: 'File fallback' }];
  assert.deepEqual(await loadMilestonesResult({
    databaseAvailable: () => true,
    databasePool: () => ({ execute: async () => { throw new Error('offline'); } }),
    fallback,
  }), { milestones: fallback, degraded: true });
});
