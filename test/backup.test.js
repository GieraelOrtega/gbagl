const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
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
