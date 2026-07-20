const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const archiver = require('archiver');
const PDFDocument = require('pdfkit');
const { PNG } = require('pngjs');
const { getPool, isDbAvailable } = require('../db');
const { existingImageName } = require('../lib/hubValidation');
const { detectImageType, safeUploadPath } = require('../lib/media');
const { withMediaOperation } = require('./mediaCoordinator');

const EXPORT_SCHEMA_VERSION = 1;
const MAX_EXPORT_PHOTOS = 500;
const MAX_MEDIA_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 160 * 1024 * 1024;
const MAX_PDF_IMAGE_PIXELS = 12 * 1024 * 1024;

const EXPORT_QUERIES = Object.freeze({
  settings: `SELECT setting_key, setting_value FROM site_settings
             WHERE setting_key IN (
               'partner_one_name', 'partner_two_name', 'anniversary_date', 'timezone'
             ) ORDER BY setting_key`,
  timeline: `SELECT id, display_order, milestone_date, title, description, emoji, photo
             FROM timeline_milestones ORDER BY display_order, id`,
  journals: `SELECT id, milestone_id, title, body,
                    DATE_FORMAT(entry_date, '%Y-%m-%d') AS entry_date
             FROM journal_entries ORDER BY entry_date, id`,
  bucket: `SELECT id, title, description, category,
                  DATE_FORMAT(target_date, '%Y-%m-%d') AS target_date,
                  DATE_FORMAT(completed_at, '%Y-%m-%d') AS completed_at,
                  memory
           FROM bucket_items WHERE completed_at IS NOT NULL ORDER BY completed_at, id`,
  events: `SELECT id, title,
                  DATE_FORMAT(event_at, '%Y-%m-%dT%H:%i:%sZ') AS event_at,
                  DATE_FORMAT(reminder_at, '%Y-%m-%dT%H:%i:%sZ') AS reminder_at,
                  notes, is_completed
           FROM shared_events ORDER BY event_at, id`,
  albums: `SELECT id, title, description,
                  DATE_FORMAT(album_date, '%Y-%m-%d') AS album_date,
                  display_order
           FROM photo_albums ORDER BY display_order, album_date, id`,
  photos: `SELECT id, album_id, milestone_id, caption,
                  DATE_FORMAT(photo_date, '%Y-%m-%d') AS photo_date,
                  display_order, storage_type, storage_name, media_type
           FROM album_photos ORDER BY album_id, display_order, id`,
});

class DatabaseUnavailableError extends Error {
  constructor() {
    super('Database is unavailable; keepsake export could not be created');
    this.code = 'DB_UNAVAILABLE';
  }
}

function safeArchiveName(value) {
  if (
    typeof value !== 'string'
    || value.includes('\\')
    || value.startsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
    || !/^[A-Za-z0-9._/-]+$/.test(value)
  ) throw new Error('Invalid generated archive entry name');
  return value;
}

function extensionFor(mediaType) {
  return {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }[mediaType] || null;
}

function mediaArchiveName(photo) {
  const extension = extensionFor(photo.media_type);
  if (
    !Number.isSafeInteger(Number(photo.id))
    || Number(photo.id) <= 0
    || !Number.isSafeInteger(Number(photo.album_id))
    || Number(photo.album_id) <= 0
    || !extension
  ) {
    throw new Error('Invalid photo export metadata');
  }
  return safeArchiveName(
    `media/albums/${String(photo.album_id).padStart(6, '0')}/photo-${String(photo.id).padStart(6, '0')}.${extension}`,
  );
}

function timelineMediaDetails(config, milestone) {
  if (
    !Number.isSafeInteger(Number(milestone.id))
    || Number(milestone.id) <= 0
    || typeof milestone.photo !== 'string'
    || milestone.photo.includes('..')
    || milestone.photo.includes('\\')
    || !/^images\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:avif|gif|jpe?g|png|svg|webp)$/i
      .test(milestone.photo)
  ) throw new Error('Invalid timeline photo metadata');
  const publicRoot = path.resolve(config.publicDir || path.join(__dirname, '..', 'public'));
  const filePath = path.resolve(publicRoot, milestone.photo);
  const relative = path.relative(publicRoot, filePath);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Invalid timeline photo path');
  }
  const extension = path.extname(filePath).slice(1).toLowerCase().replace('jpeg', 'jpg');
  const mediaType = {
    avif: 'image/avif',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  }[extension];
  return {
    archivePath: safeArchiveName(
      `media/timeline/milestone-${String(milestone.id).padStart(6, '0')}.${extension}`,
    ),
    filePath,
    mediaType,
  };
}

function hasExpectedTimelineSignature(buffer, mediaType) {
  const detected = detectImageType(buffer);
  if (['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) {
    return detected?.mediaType === mediaType;
  }
  if (mediaType === 'image/gif') {
    return ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  }
  if (mediaType === 'image/avif') {
    return buffer.subarray(4, 12).toString('ascii').startsWith('ftypavi');
  }
  if (mediaType === 'image/svg+xml') {
    return /<svg(?:\s|>)/i.test(buffer.subarray(0, 4096).toString('utf8'));
  }
  return false;
}

async function loadKeepsakeData(dependencies = {}) {
  const databaseAvailable = dependencies.isDbAvailable || isDbAvailable;
  const databasePool = dependencies.getPool || getPool;
  if (!databaseAvailable()) throw new DatabaseUnavailableError();
  const database = databasePool();
  if (!database) throw new DatabaseUnavailableError();
  const connection = typeof database.getConnection === 'function'
    ? await database.getConnection()
    : database;
  const ownsConnection = connection !== database;
  let transactionStarted = false;
  try {
    if (typeof connection.query === 'function' && typeof connection.commit === 'function') {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
      transactionStarted = true;
    } else {
      await connection.beginTransaction();
      transactionStarted = true;
    }
    const data = {};
    for (const [key, query] of Object.entries(EXPORT_QUERIES)) {
      [data[key]] = await connection.query(query);
    }
    await connection.commit();
    transactionStarted = false;
    return {
      settings: Object.fromEntries(
        data.settings.map((row) => [row.setting_key, row.setting_value]),
      ),
      timeline: data.timeline,
      journals: data.journals,
      completedBucketItems: data.bucket,
      events: data.events,
      albums: data.albums,
      photos: data.photos,
    };
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    if (ownsConnection) connection.release();
  }
}

function resolveMediaPath(config, photo) {
  if (photo.storage_type === 'upload') {
    return safeUploadPath(config.uploadDir, photo.storage_name);
  }
  if (photo.storage_type !== 'existing') throw new Error('Invalid photo storage type');
  const name = existingImageName(photo.storage_name);
  const root = path.resolve(config.publicDir || path.join(__dirname, '..', 'public'), 'images');
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) throw new Error('Invalid existing photo path');
  return target;
}

function mediaRoot(config, photo) {
  return photo.storage_type === 'upload'
    ? path.resolve(config.uploadDir)
    : path.resolve(config.publicDir || path.join(__dirname, '..', 'public'), 'images');
}

async function boundedRegularFile(filePath, allowedRoot) {
  const [root, target, linkStat] = await Promise.all([
    fs.promises.realpath(allowedRoot),
    fs.promises.realpath(filePath),
    fs.promises.lstat(filePath),
  ]);
  const relative = path.relative(root, target);
  if (
    linkStat.isSymbolicLink()
    || relative.startsWith(`..${path.sep}`)
    || relative === '..'
    || path.isAbsolute(relative)
  ) throw new Error('Media path escapes its configured root');
  const stat = await fs.promises.stat(target);
  if (!stat.isFile() || stat.size > MAX_MEDIA_FILE_BYTES) {
    throw new Error('Media is not a bounded regular file');
  }
  return { path: target, size: stat.size };
}

async function loadExportMedia(config, photos, timeline) {
  const timelineWithPhotos = timeline.filter((milestone) => milestone.photo);
  if (photos.length + timelineWithPhotos.length > MAX_EXPORT_PHOTOS) {
    throw new Error(`Keepsake export is limited to ${MAX_EXPORT_PHOTOS} photos`);
  }
  let totalBytes = 0;
  const media = [];
  for (const photo of photos) {
    const archivePath = mediaArchiveName(photo);
    try {
      const filePath = resolveMediaPath(config, photo);
      const file = await boundedRegularFile(filePath, mediaRoot(config, photo));
      totalBytes += file.size;
      if (totalBytes > MAX_TOTAL_MEDIA_BYTES) {
        throw new Error('Keepsake media exceeds the total export limit');
      }
      const buffer = await fs.promises.readFile(file.path);
      const detected = detectImageType(buffer);
      if (!detected || detected.mediaType !== photo.media_type) {
        throw new Error('Photo type does not match its stored metadata');
      }
      media.push({
        archivePath,
        buffer,
        kind: 'album',
        mediaType: photo.media_type,
        record: photo,
        status: 'included',
      });
    } catch (error) {
      if (/total export limit|limited to/.test(error.message)) throw error;
      media.push({
        archivePath,
        buffer: null,
        kind: 'album',
        mediaType: photo.media_type,
        record: photo,
        status: 'missing-or-unreadable',
      });
    }
  }
  for (const milestone of timelineWithPhotos) {
    let details;
    try {
      details = timelineMediaDetails(config, milestone);
      const publicRoot = path.resolve(config.publicDir || path.join(__dirname, '..', 'public'));
      const file = await boundedRegularFile(details.filePath, publicRoot);
      totalBytes += file.size;
      if (totalBytes > MAX_TOTAL_MEDIA_BYTES) {
        throw new Error('Keepsake media exceeds the total export limit');
      }
      const buffer = await fs.promises.readFile(file.path);
      if (!hasExpectedTimelineSignature(buffer, details.mediaType)) {
        throw new Error('Timeline photo contents do not match the extension');
      }
      media.push({
        ...details,
        buffer,
        kind: 'timeline',
        record: milestone,
        status: 'included',
      });
    } catch (error) {
      if (/total export limit|limited to/.test(error.message)) throw error;
      const archivePath = details?.archivePath
        || safeArchiveName(`media/timeline/milestone-${String(milestone.id).padStart(6, '0')}.missing`);
      media.push({
        archivePath,
        buffer: null,
        kind: 'timeline',
        mediaType: details?.mediaType || 'application/octet-stream',
        record: milestone,
        status: 'missing-or-unreadable',
      });
    }
  }
  return media;
}

function publicExportData(data, media, generatedAt) {
  const albumStatus = new Map(media
    .filter((item) => item.kind === 'album')
    .map((item) => [Number(item.record.id), item]));
  const timelineStatus = new Map(media
    .filter((item) => item.kind === 'timeline')
    .map((item) => [Number(item.record.id), item]));
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    settings: data.settings,
    timeline: data.timeline.map(({ photo, ...milestone }) => {
      const item = timelineStatus.get(Number(milestone.id));
      return {
        ...milestone,
        archive_path: item?.archivePath || null,
        media_status: item?.status || null,
        media_type: item?.mediaType || null,
      };
    }),
    journals: data.journals,
    completedBucketItems: data.completedBucketItems,
    events: data.events,
    albums: data.albums,
    photos: data.photos.map((photo) => {
      const item = albumStatus.get(Number(photo.id));
      return {
        id: photo.id,
        album_id: photo.album_id,
        milestone_id: photo.milestone_id,
        caption: photo.caption,
        photo_date: photo.photo_date,
        display_order: photo.display_order,
        media_type: photo.media_type,
        archive_path: item.archivePath,
        media_status: item.status,
      };
    }),
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function htmlList(items, render) {
  return items.length
    ? `<div class="list">${items.map(render).join('')}</div>`
    : '<p class="empty">None recorded.</p>';
}

function buildPrintableHtml(exportData) {
  const names = [
    exportData.settings.partner_one_name || 'Partner One',
    exportData.settings.partner_two_name || 'Partner Two',
  ];
  const photosByAlbum = new Map();
  exportData.photos.forEach((photo) => {
    if (!photosByAlbum.has(photo.album_id)) photosByAlbum.set(photo.album_id, []);
    photosByAlbum.get(photo.album_id).push(photo);
  });
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>GBAGL Keepsake</title><style>
body{font:16px/1.55 Georgia,serif;color:#3d2a2f;max-width:900px;margin:auto;padding:32px}
h1,h2{color:#c94d60}h1{text-align:center}.meta{text-align:center;color:#8b6070}
.item{break-inside:avoid;border-top:1px solid #f5d0d8;padding:14px 0}.photo{max-width:100%;max-height:520px}
.caption,.empty{color:#8b6070}@media print{body{max-width:none}.item{page-break-inside:avoid}}
</style></head><body>
<h1>${escapeHtml(names[0])} &amp; ${escapeHtml(names[1])}</h1>
<p class="meta">GBAGL relationship keepsake${exportData.settings.anniversary_date
    ? ` · Anniversary ${escapeHtml(exportData.settings.anniversary_date)}` : ''}</p>
<h2>Timeline</h2>${htmlList(exportData.timeline, (item) => `<article class="item"><strong>${escapeHtml(item.milestone_date)} · ${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p>${item.archive_path ? (item.media_status === 'included' && item.media_type !== 'image/svg+xml' ? `<img class="photo" src="${escapeHtml(item.archive_path)}" alt="">` : `<p class="empty">Timeline photo included as ${escapeHtml(item.archive_path)}.</p>`) : ''}</article>`)}
<h2>Journal</h2>${htmlList(exportData.journals, (item) => `<article class="item"><strong>${escapeHtml(item.entry_date)} · ${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body).replace(/\n/g, '<br>')}</p></article>`)}
<h2>Completed bucket memories</h2>${htmlList(exportData.completedBucketItems, (item) => `<article class="item"><strong>${escapeHtml(item.completed_at)} · ${escapeHtml(item.title)}</strong><p>${escapeHtml(item.memory || item.description).replace(/\n/g, '<br>')}</p></article>`)}
<h2>Shared events</h2>${htmlList(exportData.events, (item) => `<article class="item"><strong>${escapeHtml(item.event_at)} · ${escapeHtml(item.title)}</strong><p>${escapeHtml(item.notes || '')}</p></article>`)}
<h2>Albums</h2>${htmlList(exportData.albums, (album) => `<section class="item"><h3>${escapeHtml(album.title)}</h3><p>${escapeHtml(album.description)}</p>${htmlList(photosByAlbum.get(album.id) || [], (photo) => `<figure>${photo.media_status === 'included' ? `<img class="photo" src="${escapeHtml(photo.archive_path)}" alt="">` : `<p class="empty">Photo file unavailable (${escapeHtml(photo.archive_path)}).</p>`}<figcaption class="caption">${escapeHtml(photo.caption || `Photo ${photo.id}`)}</figcaption></figure>`)}</section>`)}
</body></html>`;
}

function textValue(value) {
  return value === null || value === undefined || value === '' ? 'Not recorded' : String(value);
}

function assertImageDimensions(width, height) {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || width * height > MAX_PDF_IMAGE_PIXELS
  ) throw new Error('Image dimensions exceed the PDF export limit');
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('Invalid JPEG image');
  }
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw new Error('Invalid JPEG segment');
    if (startOfFrame.has(marker)) {
      if (length < 7) throw new Error('Invalid JPEG frame');
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      assertImageDimensions(width, height);
      return { width, height };
    }
    offset += length;
  }
  throw new Error('JPEG dimensions were not found');
}

function safePdfImage(buffer, mediaType) {
  if (mediaType === 'image/jpeg') {
    jpegDimensions(buffer);
    return buffer;
  }
  if (mediaType !== 'image/png' || buffer.length < 33) {
    throw new Error('PDF image must be a JPEG or PNG');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assertImageDimensions(width, height);
  const decoded = PNG.sync.read(buffer, { checkCRC: true });
  assertImageDimensions(decoded.width, decoded.height);
  return PNG.sync.write(decoded, {
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
  });
}

function addPdfSection(doc, title, items, renderItem) {
  doc.moveDown(0.7).font('Helvetica-Bold').fontSize(17).fillColor('#c94d60').text(title);
  if (!items.length) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#8b6070').text('None recorded.');
    return;
  }
  items.forEach((item) => {
    if (doc.y > 700) doc.addPage();
    doc.moveDown(0.4);
    renderItem(item);
  });
}

function buildPdf(exportData, media) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    const doc = new PDFDocument({
      bufferPages: true,
      compress: false,
      info: {
        Title: 'GBAGL Relationship Keepsake',
        Author: 'GBAGL',
        Subject: 'Timeline, journal, memories, events, and albums',
      },
      margins: { top: 54, right: 54, bottom: 58, left: 54 },
    });
    doc.on('data', (chunk) => {
      byteLength += chunk.length;
      if (byteLength <= MAX_OUTPUT_BYTES) chunks.push(chunk);
    });
    doc.on('error', reject);
    doc.on('end', () => {
      if (byteLength > MAX_OUTPUT_BYTES) {
        reject(new Error('PDF export exceeded the output limit'));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    const first = exportData.settings.partner_one_name || 'Partner One';
    const second = exportData.settings.partner_two_name || 'Partner Two';
    doc.font('Times-Bold').fontSize(28).fillColor('#c94d60').text('Our GBAGL Keepsake', {
      align: 'center',
    });
    doc.font('Times-Roman').fontSize(16).fillColor('#3d2a2f')
      .text(`${first} & ${second}`, { align: 'center' });
    doc.fontSize(10).fillColor('#8b6070').text(
      `Anniversary: ${textValue(exportData.settings.anniversary_date)}`,
      { align: 'center' },
    );

    const timelineMedia = new Map(media
      .filter((item) => item.kind === 'timeline')
      .map((item) => [Number(item.record.id), item]));
    addPdfSection(doc, 'Timeline', exportData.timeline, (item) => {
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#3d2a2f')
        .text(`${textValue(item.milestone_date)} - ${textValue(item.title)}`);
      doc.font('Helvetica').fontSize(10).text(textValue(item.description));
      const image = timelineMedia.get(Number(item.id));
      if (image?.buffer && ['image/jpeg', 'image/png'].includes(image.mediaType)) {
        try {
          doc.image(safePdfImage(image.buffer, image.mediaType), {
            fit: [450, 260],
            align: 'center',
          });
        } catch {
          doc.font('Helvetica-Oblique').fontSize(9)
            .text('Timeline photo could not be embedded.');
        }
      } else if (image) {
        doc.font('Helvetica-Oblique').fontSize(9)
          .text(`${image.mediaType === 'image/webp' ? 'WebP' : 'Timeline'} photo included in ZIP as ${image.archivePath}.`);
      }
    });
    addPdfSection(doc, 'Journal', exportData.journals, (item) => {
      doc.font('Helvetica-Bold').fontSize(11)
        .text(`${textValue(item.entry_date)} - ${textValue(item.title)}`);
      doc.font('Helvetica').fontSize(10).text(textValue(item.body));
    });
    addPdfSection(doc, 'Completed bucket memories', exportData.completedBucketItems, (item) => {
      doc.font('Helvetica-Bold').fontSize(11)
        .text(`${textValue(item.completed_at)} - ${textValue(item.title)}`);
      doc.font('Helvetica').fontSize(10).text(textValue(item.memory || item.description));
    });
    addPdfSection(doc, 'Shared events', exportData.events, (item) => {
      doc.font('Helvetica-Bold').fontSize(11)
        .text(`${textValue(item.event_at)} - ${textValue(item.title)}`);
      if (item.notes) doc.font('Helvetica').fontSize(10).text(item.notes);
    });

    const albumById = new Map(exportData.albums.map((album) => [Number(album.id), album]));
    addPdfSection(doc, 'Albums and photos', media.filter((item) => item.kind === 'album'), (item) => {
      const photo = item.record;
      const album = albumById.get(Number(photo.album_id));
      doc.font('Helvetica-Bold').fontSize(11)
        .text(`${album?.title || 'Album'} - ${photo.caption || `Photo ${photo.id}`}`);
      if (!item.buffer) {
        doc.font('Helvetica-Oblique').fontSize(9).text('Photo file was missing or unreadable.');
      } else if (photo.media_type === 'image/webp') {
        doc.font('Helvetica-Oblique').fontSize(9)
          .text(`WebP photo included in ZIP as ${item.archivePath}.`);
      } else {
        try {
          doc.image(safePdfImage(item.buffer, photo.media_type), {
            fit: [450, 300],
            align: 'center',
          });
        } catch {
          doc.font('Helvetica-Oblique').fontSize(9)
            .text('Photo could not be embedded; its caption remains in this PDF.');
        }
      }
    });

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      doc.font('Helvetica').fontSize(8).fillColor('#8b6070')
        .text(`Page ${index + 1} of ${range.count}`, 54, doc.page.height - 38, {
          align: 'center',
          width: doc.page.width - 108,
        });
    }
    doc.end();
  });
}

function collectArchive(archive) {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks = [];
    let byteLength = 0;
    output.on('data', (chunk) => {
      byteLength += chunk.length;
      if (byteLength <= MAX_OUTPUT_BYTES) chunks.push(chunk);
    });
    output.on('end', () => {
      if (byteLength > MAX_OUTPUT_BYTES) {
        reject(new Error('ZIP export exceeded the output limit'));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
  });
}

async function buildZip(exportData, media) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const result = collectArchive(archive);
  archive.append(buildPrintableHtml(exportData), {
    name: safeArchiveName('keepsake.html'),
  });
  archive.append(JSON.stringify(exportData, null, 2), {
    name: safeArchiveName('data.json'),
  });
  archive.append(JSON.stringify({
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: exportData.generatedAt,
    contents: ['keepsake.html', 'data.json', 'media/'],
    missingMedia: media
      .filter((item) => item.status !== 'included')
      .map((item) => ({
        kind: item.kind,
        recordId: item.record.id,
        archivePath: item.archivePath,
      })),
  }, null, 2), { name: safeArchiveName('manifest.json') });
  media.filter((item) => item.buffer).forEach((item) => {
    archive.append(item.buffer, { name: item.archivePath });
  });
  await archive.finalize();
  return result;
}

function createKeepsakeExportService(config, dependencies = {}) {
  const loadData = dependencies.loadKeepsakeData
    || (() => loadKeepsakeData(dependencies));
  const coordinate = dependencies.withMediaOperation || withMediaOperation;
  const now = dependencies.now || (() => new Date());

  async function prepare() {
    const data = await loadData();
    const media = await loadExportMedia(config, data.photos, data.timeline);
    return {
      media,
      exportData: publicExportData(data, media, now()),
    };
  }

  return {
    createPdf: () => coordinate(async () => {
      const { exportData, media } = await prepare();
      return buildPdf(exportData, media);
    }),
    createZip: () => coordinate(async () => {
      const { exportData, media } = await prepare();
      return buildZip(exportData, media);
    }),
  };
}

module.exports = {
  DatabaseUnavailableError,
  EXPORT_QUERIES,
  EXPORT_SCHEMA_VERSION,
  buildPdf,
  buildPrintableHtml,
  buildZip,
  createKeepsakeExportService,
  loadKeepsakeData,
  mediaArchiveName,
  safePdfImage,
  safeArchiveName,
};
