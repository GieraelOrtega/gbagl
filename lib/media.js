const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_HEIC_PIXELS = 32_000_000;
const MAX_CONVERTED_BYTES = 25 * 1024 * 1024;
const HEIC_BRANDS = new Set([
  'heic',
  'heis',
  'heix',
  'heim',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
]);
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
  {
    mediaType: 'image/heic',
    extension: '.heic',
    convertToJpeg: true,
    matches: (buffer) => buffer.length >= 12
      && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
      && HEIC_BRANDS.has(buffer.subarray(8, 12).toString('ascii')),
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

function heicPixelCount(buffer) {
  let largest = 0;
  for (let offset = 4; offset <= buffer.length - 16; offset += 1) {
    if (buffer.subarray(offset, offset + 4).toString('ascii') !== 'ispe') continue;
    const boxSize = buffer.readUInt32BE(offset - 4);
    if (boxSize < 20 || offset - 4 + boxSize > buffer.length) continue;
    const width = buffer.readUInt32BE(offset + 8);
    const height = buffer.readUInt32BE(offset + 12);
    const pixels = width * height;
    if (Number.isSafeInteger(pixels)) largest = Math.max(largest, pixels);
  }
  if (largest <= 0) throw new Error('HEIC photo dimensions could not be verified');
  return largest;
}

async function convertHeicUpload(filePath, finalPath, converter) {
  const input = await fs.promises.readFile(filePath);
  if (heicPixelCount(input) > MAX_HEIC_PIXELS) {
    throw new Error('HEIC photo is too large. Choose a version under 32 megapixels.');
  }
  let output;
  try {
    output = await converter({
      buffer: input,
      format: 'JPEG',
      quality: 0.85,
    });
  } catch {
    throw new Error('HEIC photo could not be converted. Export it as JPEG and try again.');
  }
  const converted = Buffer.from(output);
  if (
    converted.length > MAX_CONVERTED_BYTES
    || detectImageType(converted)?.mediaType !== 'image/jpeg'
  ) {
    throw new Error('HEIC photo conversion did not produce a valid JPEG');
  }
  await fs.promises.writeFile(finalPath, converted, { flag: 'wx', mode: 0o600 });
}

async function inspectAndStoreUpload(file, uploadDir, dependencies = {}) {
  if (!file?.path) throw new Error('Choose a JPEG, PNG, WebP, HEIC, or HEIF photo');
  let finalPath = null;
  try {
    const handle = await fs.promises.open(file.path, 'r');
    const header = Buffer.alloc(32);
    try {
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }
    const detected = detectImageType(header);
    if (!detected) {
      throw new Error('Photo contents must be JPEG, PNG, WebP, HEIC, or HEIF');
    }
    const extension = detected.convertToJpeg ? '.jpg' : detected.extension;
    const mediaType = detected.convertToJpeg ? 'image/jpeg' : detected.mediaType;
    const storageName = `${crypto.randomBytes(16).toString('hex')}${extension}`;
    finalPath = safeUploadPath(uploadDir, storageName);
    if (detected.convertToJpeg) {
      const converter = dependencies.convertHeic || require('heic-convert');
      await convertHeicUpload(file.path, finalPath, converter);
      await fs.promises.rm(file.path, { force: true });
    } else {
      await fs.promises.rename(file.path, finalPath);
    }
    return { mediaType, storageName };
  } catch (error) {
    await Promise.allSettled([
      fs.promises.rm(file.path, { force: true }),
      finalPath ? fs.promises.rm(finalPath, { force: true }) : Promise.resolve(),
    ]);
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
  if (!detected || detected.convertToJpeg) {
    throw new Error('Existing photo contents must be JPEG, PNG, or WebP');
  }
  return detected.mediaType;
}

async function removeUpload(uploadDir, storageName) {
  await fs.promises.rm(safeUploadPath(uploadDir, storageName), { force: true });
}

module.exports = {
  detectImageType,
  heicPixelCount,
  inspectExistingImage,
  inspectAndStoreUpload,
  removeUpload,
  safeUploadPath,
};
