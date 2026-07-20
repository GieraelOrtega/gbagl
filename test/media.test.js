const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  detectImageType,
  inspectAndStoreUpload,
  safeUploadPath,
} = require('../lib/media');
const { existingImageName } = require('../lib/hubValidation');

test('upload signatures are detected from bytes rather than names or MIME claims', () => {
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00])).mediaType, 'image/jpeg');
  assert.equal(
    detectImageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])).mediaType,
    'image/png',
  );
  assert.equal(
    detectImageType(Buffer.from('RIFF0000WEBP', 'ascii')).mediaType,
    'image/webp',
  );
  assert.equal(detectImageType(Buffer.from('<svg></svg>')), null);
});

test('upload and deployment-local image paths reject traversal', () => {
  const uploadDir = path.resolve('runtime', 'uploads-test');
  assert.throws(() => safeUploadPath(uploadDir, '../secret.jpg'), /Invalid/);
  assert.throws(() => safeUploadPath(uploadDir, 'friendly.jpg'), /Invalid/);
  assert.match(
    safeUploadPath(uploadDir, `${'a'.repeat(32)}.webp`),
    /[a-f0-9]{32}\.webp$/,
  );
  assert.equal(existingImageName('/images/private-photo.jpg'), 'private-photo.jpg');
  assert.throws(() => existingImageName('/images/../secret.jpg'), /basename/);
});

test('rejected upload contents are removed on failure', async (t) => {
  const uploadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gbagl-upload-'));
  t.after(() => fs.promises.rm(uploadDir, { force: true, recursive: true }));
  const temporary = path.join(uploadDir, 'temporary.upload');
  await fs.promises.writeFile(temporary, '<svg>not allowed</svg>');

  await assert.rejects(
    inspectAndStoreUpload({ path: temporary }, uploadDir),
    /contents must be JPEG, PNG, or WebP/,
  );
  await assert.rejects(fs.promises.access(temporary));
});
