const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SIGNATURES = [
  {
    mediaType: 'image/jpeg',
    extension: '.jpg',
    matches: (buffer) => buffer.length >= 3
      && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  {
    mediaType: 'image/png',
    extension: '.png',
    matches: (buffer) => buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  {
    mediaType: 'image/webp',
    extension: '.webp',
    matches: (buffer) => buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

function detectImageType(buffer) {
  return SIGNATURES.find((signature) => signature.matches(buffer)) || null;
}

function safeUploadPath(uploadDir, storageName) {
  if (
    typeof storageName !== 'string'
    || !/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(storageName)
  ) {
    throw new Error('Invalid upload storage name');
  }
  const root = path.resolve(uploadDir);
  const target = path.resolve(root, storageName);
  if (path.dirname(target) !== root) throw new Error('Invalid upload path');
  return target;
}

async function inspectAndStoreUpload(file, uploadDir) {
  if (!file?.path) throw new Error('Choose a JPEG, PNG, or WebP photo');
  try {
    const handle = await fs.promises.open(file.path, 'r');
    const header = Buffer.alloc(16);
    try {
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }
    const detected = detectImageType(header);
    if (!detected) throw new Error('Photo contents must be JPEG, PNG, or WebP');
    const storageName = `${crypto.randomBytes(16).toString('hex')}${detected.extension}`;
    const finalPath = safeUploadPath(uploadDir, storageName);
    await fs.promises.rename(file.path, finalPath);
    return { mediaType: detected.mediaType, storageName };
  } catch (error) {
    await fs.promises.rm(file.path, { force: true });
    throw error;
  }
}

async function inspectExistingImage(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  const header = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const detected = detectImageType(header);
  if (!detected) throw new Error('Existing photo contents must be JPEG, PNG, or WebP');
  return detected.mediaType;
}

async function removeUpload(uploadDir, storageName) {
  await fs.promises.rm(safeUploadPath(uploadDir, storageName), { force: true });
}

module.exports = {
  detectImageType,
  inspectExistingImage,
  inspectAndStoreUpload,
  removeUpload,
  safeUploadPath,
};
