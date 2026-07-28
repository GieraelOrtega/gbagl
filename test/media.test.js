const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  detectImageType,
  heicPixelCount,
  inspectAndStoreUpload,
  safeUploadPath,
} = require('../lib/media');
const { existingImageName } = require('../lib/hubValidation');

function heicBytes(width = 4032, height = 3024) {
  const bytes = Buffer.alloc(40);
  bytes.writeUInt32BE(16, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('heic', 8, 'ascii');
  bytes.writeUInt32BE(20, 16);
  bytes.write('ispe', 20, 'ascii');
  bytes.writeUInt32BE(width, 28);
  bytes.writeUInt32BE(height, 32);
  return bytes;
}

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
  assert.equal(detectImageType(heicBytes()).mediaType, 'image/heic');
  assert.equal(detectImageType(Buffer.from('<svg></svg>')), null);
});

test('HEIC uploads are dimension-checked and converted to protected JPEG files', async (t) => {
  const uploadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gbagl-heic-'));
  t.after(() => fs.promises.rm(uploadDir, { force: true, recursive: true }));
  const temporary = path.join(uploadDir, 'temporary.upload');
  await fs.promises.writeFile(temporary, heicBytes());

  assert.equal(heicPixelCount(heicBytes()), 4032 * 3024);
  const stored = await inspectAndStoreUpload(
    { path: temporary },
    uploadDir,
    { convertHeic: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
  );

  assert.equal(stored.mediaType, 'image/jpeg');
  assert.match(stored.storageName, /^[a-f0-9]{32}\.jpg$/);
  assert.deepEqual(
    await fs.promises.readFile(path.join(uploadDir, stored.storageName)),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  );
  await assert.rejects(fs.promises.access(temporary));
});

test('oversized HEIC uploads fail before conversion and remove temporary bytes', async (t) => {
  const uploadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gbagl-heic-large-'));
  t.after(() => fs.promises.rm(uploadDir, { force: true, recursive: true }));
  const temporary = path.join(uploadDir, 'temporary.upload');
  await fs.promises.writeFile(temporary, heicBytes(9000, 5000));
  let converted = false;

  await assert.rejects(
    inspectAndStoreUpload(
      { path: temporary },
      uploadDir,
      { convertHeic: async () => { converted = true; } },
    ),
    /under 32 megapixels/,
  );
  assert.equal(converted, false);
  await assert.rejects(fs.promises.access(temporary));
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
    /contents must be JPEG, PNG, WebP, HEIC, or HEIF/,
  );
  await assert.rejects(fs.promises.access(temporary));
});
