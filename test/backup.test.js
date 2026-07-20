const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TABLES,
  createBackupService,
  scheduleBackups,
} = require('../services/backup');
const { MAX_BACKUP_INTERVAL_HOURS } = require('../config');

test('concurrent backup requests create distinct complete archives', async (t) => {
  const backupDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gbagl-backup-'));
  t.after(() => fs.promises.rm(backupDir, { force: true, recursive: true }));
  const service = createBackupService({
    backupDir,
    backupMediaPaths: [],
    backupRetention: 7,
  }, {
    isDbAvailable: () => true,
    getPool: () => ({
      query: async (sql) => [[{ exportedFrom: sql }]],
    }),
  });

  const [first, second] = await Promise.all([service.create(), service.create()]);
  assert.notEqual(first.filename, second.filename);
  const backups = await service.list();
  assert.deepEqual(
    new Set(backups.map((backup) => backup.name)),
    new Set([first.filename, second.filename]),
  );
  assert.ok((await fs.promises.stat(first.path)).size > 0);
  assert.ok((await fs.promises.stat(second.path)).size > 0);
  assert.deepEqual(
    (await fs.promises.readdir(backupDir)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('backup scheduler rejects values that would overflow Node timers', () => {
  const service = { create: async () => ({ filename: 'unused.zip' }) };
  assert.throws(
    () => scheduleBackups(service, MAX_BACKUP_INTERVAL_HOURS + 1),
    /integer from 1/,
  );
  assert.throws(() => scheduleBackups(service, 0), /integer from 1/);
});

test('backup service defensively rejects recursive media configuration', () => {
  const backupDir = path.resolve('runtime', 'backups-test');
  assert.throws(() => createBackupService({
    backupDir,
    backupMediaPaths: [path.dirname(backupDir)],
    backupRetention: 7,
  }), /must not contain or be contained by BACKUP_DIR/);
});

test('media traversal excludes backup archives and in-progress output names', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gbagl-media-'));
  const backupDir = path.join(root, 'backups');
  const mediaDir = path.join(root, 'media');
  await fs.promises.mkdir(mediaDir);
  await Promise.all([
    fs.promises.writeFile(path.join(mediaDir, 'photo.txt'), 'private media'),
    fs.promises.writeFile(
      path.join(mediaDir, 'gbagl-backup-2026-07-19T12-34-56.789Z.zip'),
      'old backup',
    ),
    fs.promises.writeFile(
      path.join(mediaDir, 'gbagl-backup-2026-07-19T12-34-56.789Z-012345abcdef.zip'),
      'new backup',
    ),
    fs.promises.writeFile(
      path.join(
        mediaDir,
        'gbagl-backup-2026-07-19T12-34-56.789Z-012345abcdef.zip.call.tmp',
      ),
      'in-progress backup',
    ),
  ]);
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }));

  const service = createBackupService({
    backupDir,
    backupMediaPaths: [mediaDir],
    backupRetention: 7,
  }, {
    isDbAvailable: () => true,
    getPool: () => ({ query: async () => [[]] }),
  });

  const backup = await service.create();
  const archiveBytes = await fs.promises.readFile(backup.path);
  const archiveText = archiveBytes.toString('latin1');

  assert.match(archiveText, /media\/media\/photo\.txt/);
  assert.doesNotMatch(archiveText, /media\/media\/gbagl-backup-/);
});

test('backup exports every Layer 2 table from one consistent database snapshot', async (t) => {
  const backupDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gbagl-snapshot-'));
  t.after(() => fs.promises.rm(backupDir, { force: true, recursive: true }));
  const calls = [];
  const connection = {
    query: async (sql) => {
      calls.push(sql);
      return sql.startsWith('SELECT') ? [[{ table: sql }]] : [[]];
    },
    commit: async () => calls.push('COMMIT'),
    rollback: async () => calls.push('ROLLBACK'),
    release: () => calls.push('RELEASE'),
  };
  const service = createBackupService({
    backupDir,
    backupMediaPaths: [],
    backupRetention: 7,
  }, {
    isDbAvailable: () => true,
    getPool: () => ({ getConnection: async () => connection }),
  });

  await service.create();
  assert.deepEqual(TABLES, [
    'date_ideas',
    'site_settings',
    'timeline_milestones',
    'bucket_items',
    'bucket_votes',
    'shared_events',
    'photo_albums',
    'album_photos',
    'journal_entries',
  ]);
  assert.equal(calls[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  assert.equal(calls[1], 'START TRANSACTION WITH CONSISTENT SNAPSHOT');
  assert.equal(calls.filter((sql) => String(sql).startsWith('SELECT')).length, TABLES.length);
  assert.ok(calls.indexOf('COMMIT') > calls.findLastIndex(
    (sql) => String(sql).startsWith('SELECT'),
  ));
  assert.equal(calls.at(-1), 'RELEASE');
});
