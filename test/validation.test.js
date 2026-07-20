const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  imagePath,
  optionalUrl,
  positiveId,
  validateSettings,
} = require('../lib/validation');
const { validateEvent } = require('../lib/hubValidation');
const { backupFilename, resolveBackupPath } = require('../services/backup');

test('admin validation accepts safe values and rejects traversal or unsafe URLs', () => {
  assert.equal(imagePath('images/trips/day-one.webp'), 'images/trips/day-one.webp');
  assert.throws(() => imagePath('../private.jpg'), /Image path/);
  assert.throws(() => imagePath('images\\private.jpg'), /Image path/);
  assert.equal(optionalUrl('https://example.com/memory'), 'https://example.com/memory');
  assert.throws(() => optionalUrl('javascript:alert(1)'), /HTTP or HTTPS/);
  assert.equal(positiveId('42'), 42);
  assert.throws(() => positiveId('42x'), /Invalid record ID/);

  assert.deepEqual(validateSettings({
    partner_one_name: 'Alex',
    partner_two_name: 'Sam',
    anniversary_date: '2025-07-19',
    timezone: 'America/Los_Angeles',
  }), {
    partner_one_name: 'Alex',
    partner_two_name: 'Sam',
    anniversary_date: '2025-07-19',
    timezone: 'America/Los_Angeles',
  });

});

test('event validation rejects reminders scheduled after an event', () => {
  assert.throws(() => validateEvent({
    title: 'Dinner',
    event_at: '2026-07-19T18:00',
    reminder_at: '2026-07-19T19:00',
    notes: '',
  }), /must not be after/);
});

test('backup names are allowlisted and stay inside the backup directory', () => {
  const root = path.resolve('runtime', 'backups-test');
  const filename = backupFilename(
    new Date('2026-07-19T12:34:56.789Z'),
    '012345abcdef',
  );
  assert.equal(filename, 'gbagl-backup-2026-07-19T12-34-56.789Z-012345abcdef.zip');
  assert.equal(resolveBackupPath(root, filename), path.join(root, filename));
  const legacyFilename = 'gbagl-backup-2026-07-19T12-34-56.789Z.zip';
  assert.equal(
    resolveBackupPath(root, legacyFilename),
    path.join(root, legacyFilename),
  );
  assert.throws(() => resolveBackupPath(root, '../secrets.zip'), /Invalid backup/);
  assert.throws(() => resolveBackupPath(root, 'not-a-backup.zip'), /Invalid backup/);
});
