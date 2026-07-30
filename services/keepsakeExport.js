const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { ZipArchive } = require('archiver');
const bidi = require('bidi-js')();
const fontkit = require('fontkit');
const PDFDocument = require('pdfkit');
const { PNG } = require('pngjs');
const { getPool, isDbAvailable } = require('../db');
const { existingImageName } = require('../lib/hubValidation');
const { detectImageType, safeUploadPath } = require('../lib/media');
const { timelinePhotoDetails: resolveTimelinePhotoDetails } = require('../lib/timelinePhoto');
const { withMediaOperation } = require('./mediaCoordinator');

const EXPORT_SCHEMA_VERSION = 3;
const MAX_EXPORT_PHOTOS = 500;
const MAX_MEDIA_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_INSPECTED_MEDIA_BYTES = 132 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 160 * 1024 * 1024;
const MAX_PDF_IMAGE_PIXELS = 12 * 1024 * 1024;
const MAX_PDF_TOTAL_PIXELS = 48 * 1024 * 1024;
const MAX_PDF_DECODED_BYTES = 96 * 1024 * 1024;
const MAX_PDF_IMAGES = 100;

const EXPORT_QUERIES = Object.freeze({
  settings: `SELECT setting_key, setting_value FROM site_settings
             WHERE setting_key IN (
               'partner_one_name', 'partner_two_name', 'anniversary_date', 'timezone'
             ) ORDER BY setting_key`,
  timeline: `SELECT id, display_order, milestone_date, title, description, emoji, photo,
                    photo_storage_type, photo_media_type
             FROM timeline_milestones ORDER BY display_order, id`,
  journals: `SELECT id, milestone_id, title, body, display_order,
                    DATE_FORMAT(entry_date, '%Y-%m-%d') AS entry_date
             FROM journal_entries ORDER BY display_order, entry_date, id`,
  bucket: `SELECT id, title, description, category,
                  DATE_FORMAT(target_date, '%Y-%m-%d') AS target_date,
                  DATE_FORMAT(completed_at, '%Y-%m-%d') AS completed_at,
                  memory, display_order
           FROM bucket_items WHERE completed_at IS NOT NULL
           ORDER BY display_order, completed_at, id`,
  events: `SELECT id, title,
                  DATE_FORMAT(event_at, '%Y-%m-%dT%H:%i:%sZ') AS event_at,
                  DATE_FORMAT(reminder_at, '%Y-%m-%dT%H:%i:%sZ') AS reminder_at,
                  notes, is_completed, display_order
           FROM shared_events ORDER BY display_order, event_at, id`,
  photos: `SELECT id, journal_entry_id, milestone_id, caption,
                  DATE_FORMAT(photo_date, '%Y-%m-%d') AS photo_date,
                  display_order, storage_type, storage_name, media_type
           FROM album_photos WHERE journal_entry_id IS NOT NULL
           ORDER BY journal_entry_id, display_order, id`,
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

function archiveSlug(value, fallback) {
  const slug = normalizeUserText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function uniqueArchiveName(label, extension, usedNames = new Set()) {
  if (!extension) throw new Error('Invalid photo export metadata');
  const base = archiveSlug(label, 'keepsake-photo');
  let suffix = 1;
  let candidate;
  do {
    candidate = safeArchiveName(
      `Photos/${base}${suffix === 1 ? '' : `-${suffix}`}.${extension}`,
    );
    suffix += 1;
  } while (usedNames.has(candidate.toLowerCase()));
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function mediaArchiveName(photo, usedNames) {
  return uniqueArchiveName(
    [photo.photo_date, photo.caption || 'journal-photo'].filter(Boolean).join('-'),
    extensionFor(photo.media_type),
    usedNames,
  );
}

function timelineMediaDetails(config, milestone) {
  if (
    !Number.isSafeInteger(Number(milestone.id))
    || Number(milestone.id) <= 0
  ) throw new Error('Invalid timeline photo metadata');
  const details = resolveTimelinePhotoDetails(config, milestone);
  return details;
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

async function loadExportMedia(config, photos, timeline, dependencies = {}) {
  const inspectFile = dependencies.boundedRegularFile || boundedRegularFile;
  const readFile = dependencies.readFile || fs.promises.readFile;
  const timelineWithPhotos = timeline.filter((milestone) => milestone.photo);
  if (photos.length + timelineWithPhotos.length > MAX_EXPORT_PHOTOS) {
    throw new Error(`Keepsake export is limited to ${MAX_EXPORT_PHOTOS} photos`);
  }
  let inspectedBytes = 0;
  let totalBytes = 0;
  const media = [];
  for (const photo of photos) {
    try {
      const filePath = resolveMediaPath(config, photo);
      const file = await inspectFile(filePath, mediaRoot(config, photo));
      if (inspectedBytes + file.size > MAX_TOTAL_INSPECTED_MEDIA_BYTES) {
        throw new Error('Keepsake media exceeds the inspection limit');
      }
      inspectedBytes += file.size;
      const buffer = await readFile(file.path);
      if (buffer.length > file.size) {
        inspectedBytes += buffer.length - file.size;
        if (inspectedBytes > MAX_TOTAL_INSPECTED_MEDIA_BYTES) {
          throw new Error('Keepsake media exceeds the inspection limit');
        }
      }
      const detected = detectImageType(buffer);
      if (!detected || detected.mediaType !== photo.media_type) {
        throw new Error('Photo type does not match its stored metadata');
      }
      if (
        buffer.length > MAX_MEDIA_FILE_BYTES
        || totalBytes + buffer.length > MAX_TOTAL_MEDIA_BYTES
      ) throw new Error('Keepsake media exceeds the total export limit');
      totalBytes += buffer.length;
      media.push({
        archivePath: null,
        buffer,
        kind: 'journal-photo',
        mediaType: photo.media_type,
        record: photo,
        status: 'included',
      });
    } catch (error) {
      if (/total export limit|inspection limit|limited to/.test(error.message)) throw error;
      media.push({
        archivePath: null,
        buffer: null,
        kind: 'journal-photo',
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
      const file = await inspectFile(details.filePath, details.root);
      if (inspectedBytes + file.size > MAX_TOTAL_INSPECTED_MEDIA_BYTES) {
        throw new Error('Keepsake media exceeds the inspection limit');
      }
      inspectedBytes += file.size;
      const buffer = await readFile(file.path);
      if (buffer.length > file.size) {
        inspectedBytes += buffer.length - file.size;
        if (inspectedBytes > MAX_TOTAL_INSPECTED_MEDIA_BYTES) {
          throw new Error('Keepsake media exceeds the inspection limit');
        }
      }
      if (!hasExpectedTimelineSignature(buffer, details.mediaType)) {
        throw new Error('Timeline photo contents do not match the extension');
      }
      if (
        buffer.length > MAX_MEDIA_FILE_BYTES
        || totalBytes + buffer.length > MAX_TOTAL_MEDIA_BYTES
      ) throw new Error('Keepsake media exceeds the total export limit');
      totalBytes += buffer.length;
      media.push({
        ...details,
        archivePath: null,
        buffer,
        kind: 'timeline',
        record: milestone,
        status: 'included',
      });
    } catch (error) {
      if (/total export limit|inspection limit|limited to/.test(error.message)) throw error;
      media.push({
        archivePath: null,
        buffer: null,
        kind: 'timeline',
        mediaType: details?.mediaType || 'application/octet-stream',
        record: milestone,
        status: 'missing-or-unreadable',
      });
    }
  }
  return assignMediaArchivePaths(media);
}

function assignMediaArchivePaths(media) {
  const usedNames = new Set();
  const contentPaths = new Map();
  return media.map((item) => {
    if (!item.buffer) return { ...item, archivePath: null };
    const digest = crypto
      .createHash('sha256')
      .update(item.mediaType || '')
      .update('\0')
      .update(item.buffer)
      .digest('hex');
    let archivePath = contentPaths.get(digest);
    if (!archivePath) {
      archivePath = item.kind === 'timeline'
        ? uniqueArchiveName(
          [item.record.milestone_date, item.record.title || 'timeline-photo']
            .filter(Boolean)
            .join('-'),
          extensionFor(item.mediaType)
            || String(item.extension || '').replace(/[^a-z0-9]/gi, '').toLowerCase(),
          usedNames,
        )
        : mediaArchiveName(item.record, usedNames);
      contentPaths.set(digest, archivePath);
    }
    return { ...item, archivePath };
  });
}

const MOJIBAKE_REPLACEMENTS = Object.freeze([
  ['\u00e2\u20ac\u00a8', '\n'],
  ['\u00e2\u20ac\u00a9', '\n'],
  ['\u00e2\u20ac\u02dc', '\u2018'],
  ['\u00e2\u20ac\u2122', '\u2019'],
  ['\u00e2\u20ac\u0153', '\u201c'],
  ['\u00e2\u20ac\u009d', '\u201d'],
  ['\u00e2\u20ac\ufffd', '\u201d'],
  ['\u00e2\u20ac\u201c', '\u2013'],
  ['\u00e2\u20ac\u201d', '\u2014'],
  ['\u00e2\u20ac\u00a6', '\u2026'],
  ['\u00c2\u00a0', '\u00a0'],
]);

const CP1252_BYTES = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function cp1252Byte(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint <= 0xff) return codePoint;
  return CP1252_BYTES.get(codePoint) ?? null;
}

function repairMojibake(value) {
  let text = value;
  for (const [artifact, replacement] of MOJIBAKE_REPLACEMENTS) {
    text = text.split(artifact).join(replacement);
  }
  let repaired = '';
  for (let index = 0; index < text.length; index += 1) {
    const firstCharacter = String.fromCodePoint(text.codePointAt(index));
    const first = cp1252Byte(firstCharacter);
    const sequenceLength = first >= 0xc2 && first <= 0xdf
      ? 2
      : first >= 0xe0 && first <= 0xef
        ? 3
        : first >= 0xf0 && first <= 0xf4
          ? 4
          : 0;
    if (sequenceLength && index + sequenceLength <= text.length) {
      const bytes = [first];
      let consumedUnits = firstCharacter.length;
      for (let offset = 1; offset < sequenceLength; offset += 1) {
        const character = String.fromCodePoint(text.codePointAt(index + consumedUnits));
        const byte = cp1252Byte(character);
        if (byte === null || byte < 0x80 || byte > 0xbf) break;
        bytes.push(byte);
        consumedUnits += character.length;
      }
      if (bytes.length === sequenceLength) {
        const decoded = Buffer.from(bytes).toString('utf8');
        if (!decoded.includes('\ufffd')) {
          repaired += decoded;
          index += consumedUnits - 1;
          continue;
        }
      }
    }
    repaired += firstCharacter;
    index += firstCharacter.length - 1;
  }
  return repaired;
}

function normalizeUserTextPass(value) {
  let text = repairMojibake(value.normalize('NFC'))
    .normalize('NFC')
    .replace(/\r\n?|\u0085|\u2028|\u2029/g, '\n');
  text = text.replace(/(^|\n)[\t ]*\u00d0[\t ]*(?=\n|$)/g, '$1');
  return text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
    '',
  );
}

function normalizeUserText(value) {
  let text = String(value ?? '');
  let normalized = normalizeUserTextPass(text);
  while (normalized !== text) {
    text = normalized;
    normalized = normalizeUserTextPass(text);
  }
  return normalized;
}

function normalizedOrNull(value) {
  const normalized = normalizeUserText(value);
  return normalized === '' ? null : normalized;
}

function portablePhoto(item, expected) {
  if (!expected) return null;
  if (!item || item.status !== 'included' || !item.archivePath) {
    return { status: 'unavailable' };
  }
  return {
    status: 'available',
    file: item.archivePath,
    mediaType: item.mediaType,
  };
}

function publicExportData(data, media, generatedAt) {
  const photoStatus = new Map(media
    .filter((item) => item.kind === 'journal-photo')
    .map((item) => [Number(item.record.id), item]));
  const timelineStatus = new Map(media
    .filter((item) => item.kind === 'timeline')
    .map((item) => [Number(item.record.id), item]));
  return {
    formatVersion: EXPORT_SCHEMA_VERSION,
    createdAt: generatedAt.toISOString(),
    relationship: {
      partners: [
        normalizeUserText(data.settings.partner_one_name) || 'Partner One',
        normalizeUserText(data.settings.partner_two_name) || 'Partner Two',
      ],
      anniversary: normalizedOrNull(data.settings.anniversary_date),
      timezone: normalizedOrNull(data.settings.timezone),
    },
    timeline: data.timeline.map((milestone) => ({
      date: normalizeUserText(milestone.milestone_date),
      title: normalizeUserText(milestone.title),
      description: normalizeUserText(milestone.description),
      emoji: normalizeUserText(milestone.emoji),
      photo: portablePhoto(
        timelineStatus.get(Number(milestone.id)),
        Boolean(milestone.photo),
      ),
    })),
    journals: data.journals.map((journal) => ({
      date: normalizeUserText(journal.entry_date),
      title: normalizeUserText(journal.title),
      body: normalizeUserText(journal.body),
      photos: data.photos
        .filter((photo) => Number(photo.journal_entry_id) === Number(journal.id))
        .map((photo) => {
          const item = photoStatus.get(Number(photo.id));
          return {
            caption: normalizeUserText(photo.caption),
            date: normalizeUserText(photo.photo_date),
            ...portablePhoto(item, true),
          };
        }),
    })),
    bucketMemories: data.completedBucketItems.map((item) => ({
      title: normalizeUserText(item.title),
      description: normalizeUserText(item.description),
      category: normalizeUserText(item.category),
      targetDate: normalizeUserText(item.target_date),
      completedDate: normalizeUserText(item.completed_at),
      memory: normalizeUserText(item.memory),
    })),
    sharedEvents: data.events.map((item) => ({
      title: normalizeUserText(item.title),
      date: normalizeUserText(item.event_at),
      reminder: normalizeUserText(item.reminder_at),
      notes: normalizeUserText(item.notes),
      completed: Boolean(Number(item.is_completed)),
    })),
  };
}

function escapeHtml(value) {
  return normalizeUserText(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function splitParagraphs(value) {
  return normalizeUserText(value)
    .split(/\n[\t ]*\n+/)
    .filter((paragraph) => /\S/.test(paragraph));
}

function journalLetterParts(value) {
  const paragraphs = splitParagraphs(value);
  const salutation = paragraphs.length
    && /^(?:dear|dearest|my dear|hello|hi|to)\b/i.test(paragraphs[0].trim())
    ? [paragraphs.shift()]
    : [];
  let signoff = [];
  const signoffPattern = /^(?:all my love|always|forever|love|lovingly|with love|yours)\b/i;
  for (let index = Math.max(0, paragraphs.length - 2); index < paragraphs.length; index += 1) {
    if (signoffPattern.test(paragraphs[index].trim())) {
      signoff = paragraphs.splice(index);
      break;
    }
  }
  return { salutation, body: paragraphs, signoff };
}

function validTimeZone(value) {
  const timeZone = normalizeUserText(value) || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch (error) {
    if (error instanceof RangeError) return 'UTC';
    throw error;
  }
}

function formatDisplayDate(value, includeTime = false, timeZone = 'UTC') {
  const text = normalizeUserText(value);
  if (!text) return '';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
    .test(text);
  if (!dateOnly && !timestamp) return text;
  const parsed = dateOnly
    ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])))
    : new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  if (
    dateOnly
    && (
      parsed.getUTCFullYear() !== Number(dateOnly[1])
      || parsed.getUTCMonth() !== Number(dateOnly[2]) - 1
      || parsed.getUTCDate() !== Number(dateOnly[3])
    )
  ) return text;
  return new Intl.DateTimeFormat('en-US', includeTime ? {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'long',
    timeZone: validTimeZone(timeZone),
    year: 'numeric',
  } : {
    day: 'numeric',
    month: 'long',
    timeZone: dateOnly ? 'UTC' : validTimeZone(timeZone),
    year: 'numeric',
  }).format(parsed);
}

function htmlParagraphs(paragraphs, className = '') {
  return paragraphs.map((paragraph) => (
    `<p${className ? ` class="${className}"` : ''}>${
      escapeHtml(paragraph).replace(/\t/g, '&#9;').replace(/\n/g, '<br>')
    }</p>`
  )).join('');
}

function htmlPhoto(photo, caption) {
  if (!photo) return '';
  if (photo.status !== 'available') {
    return '<p class="photo-note">This photo was unavailable when the keepsake was created.</p>';
  }
  if (photo.mediaType === 'image/svg+xml') {
    return '<p class="photo-note">A photo belongs with this moment but is not shown on the printable page.</p>';
  }
  const safeCaption = normalizeUserText(caption) || 'A shared moment';
  return `<figure><img src="${escapeHtml(photo.file)}" alt="${escapeHtml(safeCaption)}">`
    + `<figcaption>${escapeHtml(safeCaption)}</figcaption></figure>`;
}

function htmlSection(title, introduction, items, emptyMessage, renderItem) {
  return `<section class="chapter"><header class="chapter__header"><p class="eyebrow">${
    items.length === 1 ? '1 memory' : `${items.length} memories`
  }</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(introduction)}</p></header>${
    items.length
      ? `<div class="entries">${items.map(renderItem).join('')}</div>`
      : `<p class="empty">${escapeHtml(emptyMessage)}</p>`
  }</section>`;
}

function buildPrintableHtml(exportData) {
  const [first, second] = exportData.relationship.partners;
  const anniversary = formatDisplayDate(exportData.relationship.anniversary);
  const timeZone = exportData.relationship.timezone;
  const created = formatDisplayDate(exportData.createdAt, false, timeZone);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Our GBAGL Keepsake</title><style>
:root{color-scheme:light;--ink:#3d2a2f;--muted:#825f69;--rose:#bd4960;--blush:#fbf3f4;--line:#ead5da}
*{box-sizing:border-box}html{background:#f6eeee}body{max-width:880px;margin:0 auto;background:#fff;color:var(--ink);font:17px/1.7 Georgia,"Times New Roman",serif}
.cover{min-height:100vh;padding:12vh 8vw;display:grid;place-content:center;text-align:center;background:linear-gradient(145deg,#fff 25%,var(--blush));border-bottom:8px solid var(--rose)}
.cover__rule{width:76px;border:0;border-top:2px solid var(--rose);margin:24px auto}.eyebrow{margin:0 0 8px;color:var(--rose);font:700 12px/1.3 Arial,sans-serif;letter-spacing:.16em;text-transform:uppercase}
h1,h2,h3{font-family:Georgia,"Times New Roman",serif;line-height:1.14}h1{margin:0;font-size:clamp(42px,9vw,74px);font-weight:400}
.cover__names{margin:18px 0 0;font-size:clamp(21px,4vw,30px)}.cover__meta{color:var(--muted);font-size:14px}
.keepsake{padding:64px clamp(24px,7vw,72px)}.chapter{margin:0 0 76px}.chapter__header{border-bottom:2px solid var(--rose);padding-bottom:18px;margin-bottom:10px}
.chapter__header h2{font-size:34px;margin:0 0 8px;font-weight:400}.chapter__header>p:last-child{margin:0;color:var(--muted)}
.entry{padding:30px 0;border-bottom:1px solid var(--line)}.entry:last-child{border-bottom:0}.entry__date{margin:0 0 5px;color:var(--rose);font:700 12px/1.4 Arial,sans-serif;letter-spacing:.09em;text-transform:uppercase}
.entry h3{font-size:24px;margin:0 0 14px}.entry__emoji{margin-right:6px}.entry p{margin:0 0 13px}.letter{max-width:660px}
.letter__salutation,.letter__signoff{font-style:italic}.letter__salutation{margin-bottom:20px}.letter__signoff{margin-top:24px}
figure{margin:24px auto 8px;break-inside:avoid;page-break-inside:avoid;text-align:center}img{display:block;max-width:100%;max-height:680px;width:auto;height:auto;margin:auto;border-radius:4px}
figcaption{margin-top:9px;color:var(--muted);font-size:14px;font-style:italic}.photo-note,.empty{padding:18px 20px;background:var(--blush);color:var(--muted);font-style:italic;border-left:3px solid var(--line)}
.photo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:26px}.photo-grid figure{margin-top:12px}
@media(max-width:600px){body{font-size:16px}.cover{padding:14vh 24px}.keepsake{padding:46px 22px}.chapter{margin-bottom:58px}.chapter__header h2{font-size:30px}.entry h3{font-size:22px}}
@page{margin:.7in}@media print{html,body{background:#fff;max-width:none}.cover{min-height:9.5in;break-after:page;page-break-after:always;border-bottom:0}.keepsake{padding:0}.chapter{break-before:page;page-break-before:always}.chapter:first-child{break-before:auto;page-break-before:auto}.chapter__header,.entry h3,.entry__date{break-after:avoid;page-break-after:avoid}.entry{break-inside:auto}.photo-note,.empty{background:#fff}}
</style></head><body>
<header class="cover"><div><p class="eyebrow">A keepsake of our story</p><h1>Our GBAGL Keepsake</h1><hr class="cover__rule">
<p class="cover__names">${escapeHtml(first)} &amp; ${escapeHtml(second)}</p>
${anniversary ? `<p class="cover__meta">Together since ${escapeHtml(anniversary)}</p>` : ''}
${created ? `<p class="cover__meta">Created ${escapeHtml(created)}</p>` : ''}</div></header>
<main class="keepsake">
${htmlSection('Our Timeline', 'The moments that shaped our story.', exportData.timeline, 'Our next Timeline moment is still waiting to be added.', (item) => `<article class="entry">
<p class="entry__date">${escapeHtml(formatDisplayDate(item.date) || item.date || 'A moment to remember')}</p>
<h3>${item.emoji ? `<span class="entry__emoji">${escapeHtml(item.emoji)}</span>` : ''}${escapeHtml(item.title || 'A shared moment')}</h3>
${htmlParagraphs(splitParagraphs(item.description))}
${htmlPhoto(item.photo, item.title)}
</article>`)}
${htmlSection('Letters & Journal', 'Words, reflections, and photos from along the way.', exportData.journals, 'The first Journal letter is still waiting to be written.', (item) => {
    const letter = journalLetterParts(item.body);
    return `<article class="entry"><p class="entry__date">${escapeHtml(formatDisplayDate(item.date) || 'Journal letter')}</p>
<h3>${escapeHtml(item.title || 'A letter from the heart')}</h3><div class="letter">
${htmlParagraphs(letter.salutation, 'letter__salutation')}${htmlParagraphs(letter.body)}${htmlParagraphs(letter.signoff, 'letter__signoff')}</div>
${item.photos.length ? `<div class="photo-grid">${item.photos.map((photo) => htmlPhoto(photo, photo.caption || item.title)).join('')}</div>` : ''}
</article>`;
  })}
${htmlSection('Bucket Memories', 'Adventures we dreamed about and made real.', exportData.bucketMemories, 'Completed adventures will become memories here.', (item) => `<article class="entry">
<p class="entry__date">${escapeHtml(formatDisplayDate(item.completedDate) || 'Adventure completed')}</p><h3>${escapeHtml(item.title || 'A shared adventure')}</h3>
${htmlParagraphs(splitParagraphs(item.memory || item.description))}
</article>`)}
${htmlSection('Shared Events', 'Dates and plans that belong to our story.', exportData.sharedEvents, 'There are no shared events in this keepsake yet.', (item) => `<article class="entry">
<p class="entry__date">${escapeHtml(formatDisplayDate(item.date, true, timeZone) || 'A shared date')}</p><h3>${escapeHtml(item.title || 'Time together')}</h3>
${htmlParagraphs(splitParagraphs(item.notes))}
</article>`)}
</main>
</body></html>`;
}

const PDF_WIN_ANSI = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014,
]);

const PDF_FONT_FILES = Object.freeze({
  KeepsakeFallback: require.resolve(
    '@fontsource/unifont/files/unifont-latin-400-normal.woff',
  ),
  KeepsakeSans: require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'),
  'KeepsakeSans-Bold': require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf'),
  'KeepsakeSans-Oblique': require.resolve(
    'dejavu-fonts-ttf/ttf/DejaVuSans-Oblique.ttf',
  ),
  KeepsakeSerif: require.resolve('dejavu-fonts-ttf/ttf/DejaVuSerif.ttf'),
  'KeepsakeSerif-Bold': require.resolve(
    'dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf',
  ),
  'KeepsakeSerif-Italic': require.resolve(
    'dejavu-fonts-ttf/ttf/DejaVuSerif-Italic.ttf',
  ),
});

const PDF_FONT_CHOICES = Object.freeze({
  Helvetica: ['Helvetica', 'KeepsakeSans', 'KeepsakeFallback'],
  'Helvetica-Bold': ['Helvetica-Bold', 'KeepsakeSans-Bold', 'KeepsakeFallback'],
  'Helvetica-Oblique': [
    'Helvetica-Oblique',
    'KeepsakeSans-Oblique',
    'KeepsakeSans',
    'KeepsakeFallback',
  ],
  'Times-Bold': [
    'Times-Bold',
    'KeepsakeSerif-Bold',
    'KeepsakeSans-Bold',
    'KeepsakeFallback',
  ],
  'Times-Italic': [
    'Times-Italic',
    'KeepsakeSerif-Italic',
    'KeepsakeSans-Oblique',
    'KeepsakeSans',
    'KeepsakeFallback',
  ],
  'Times-Roman': ['Times-Roman', 'KeepsakeSerif', 'KeepsakeSans', 'KeepsakeFallback'],
});

const parsedPdfFonts = new Map();

function pdfText(value) {
  const normalized = normalizeUserText(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\t/g, '    ');
  let result = '';
  for (const character of normalized) {
    if (
      /\p{Emoji_Presentation}|\p{Regional_Indicator}|\p{Emoji_Modifier}/u.test(character)
      || character === '\ufe0f'
      || character === '\u200d'
      || character === '\u20e3'
    ) continue;
    result += character;
  }
  return result;
}

function builtInPdfFontSupports(value) {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return character === '\n'
      || (codePoint >= 0x20 && codePoint <= 0x7e)
      || (codePoint >= 0xa0 && codePoint <= 0xff)
      || PDF_WIN_ANSI.has(codePoint);
  });
}

function embeddedPdfFontSupports(fontName, value) {
  let font = parsedPdfFonts.get(fontName);
  if (!font) {
    font = fontkit.openSync(PDF_FONT_FILES[fontName]);
    parsedPdfFonts.set(fontName, font);
  }
  return [...value].every((character) => (
    character === '\n' || font.hasGlyphForCodePoint(character.codePointAt(0))
  ));
}

function pdfFontSupports(fontName, value) {
  return PDF_FONT_FILES[fontName]
    ? embeddedPdfFontSupports(fontName, value)
    : builtInPdfFontSupports(value);
}

function selectPdfFont(preferredFont, value) {
  const text = pdfText(value);
  const choices = PDF_FONT_CHOICES[preferredFont] || [preferredFont, 'KeepsakeFallback'];
  return choices.find((fontName) => pdfFontSupports(fontName, text))
    || 'KeepsakeFallback';
}

const pdfGraphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

function reorderPdfRuns(runs) {
  const oddLevels = runs.map((run) => run.level).filter((level) => level % 2 === 1);
  if (!oddLevels.length) return runs;
  const reordered = [...runs];
  const highestLevel = Math.max(...runs.map((run) => run.level));
  const lowestOddLevel = Math.min(...oddLevels);
  for (let level = highestLevel; level >= lowestOddLevel; level -= 1) {
    let start = -1;
    for (let index = 0; index <= reordered.length; index += 1) {
      if (index < reordered.length && reordered[index].level >= level) {
        if (start === -1) start = index;
      } else if (start !== -1) {
        const reversed = reordered.slice(start, index).reverse();
        reordered.splice(start, reversed.length, ...reversed);
        start = -1;
      }
    }
  }
  return reordered;
}

function mirroredPdfGrapheme(segment, start, mirroredCharacters) {
  let mirrored = '';
  for (let offset = 0; offset < segment.length;) {
    const character = String.fromCodePoint(segment.codePointAt(offset));
    mirrored += mirroredCharacters.get(start + offset) || character;
    offset += character.length;
  }
  return mirrored;
}

function linePdfFontRuns(preferredFont, line, direction) {
  if (!line) return [];
  const embedding = bidi.getEmbeddingLevels(line, direction);
  const mirroredCharacters = bidi.getMirroredCharactersMap(line, embedding);
  const logicalRuns = [];
  for (const { segment, index } of pdfGraphemes.segment(line)) {
    const grapheme = mirroredPdfGrapheme(segment, index, mirroredCharacters);
    const current = logicalRuns.at(-1);
    const neutral = [...grapheme].every((character) => (
      /[\p{Number}\p{Punctuation}\p{Separator}\s]/u.test(character)
    ));
    const font = neutral && current && pdfFontSupports(current.font, grapheme)
      ? current.font
      : selectPdfFont(preferredFont, grapheme);
    const level = embedding.levels[index] ?? 0;
    if (current?.font === font && current.level === level) {
      current.text += grapheme;
    } else {
      logicalRuns.push({ font, level, text: grapheme });
    }
  }
  return reorderPdfRuns(logicalRuns);
}

function pdfFontRuns(preferredFont, value) {
  const lines = pdfText(value).split('\n');
  const runs = [];
  lines.forEach((line, index) => {
    const direction = pdfTextIsRtl(line) ? 'rtl' : 'ltr';
    runs.push(...linePdfFontRuns(preferredFont, line, direction));
    if (index < lines.length - 1) {
      runs.push({
        font: runs.at(-1)?.font || selectPdfFont(preferredFont, ' '),
        level: 0,
        text: '\n',
      });
    }
  });
  return runs.map(({ font, text }) => ({ font, text }));
}

function pdfTextIsRtl(value) {
  const firstLine = pdfText(value).split('\n')[0];
  if (!firstLine) return false;
  return bidi.getEmbeddingLevels(firstLine).paragraphs[0]?.level % 2 === 1;
}

function pdfTextWidth(doc, preferredFont, value, options = {}) {
  return pdfFontRuns(preferredFont, value).reduce((width, run) => (
    width + doc.font(run.font).widthOfString(run.text, {
      characterSpacing: options.characterSpacing || 0,
    })
  ), 0);
}

function splitLongPdfToken(doc, preferredFont, token, width, options) {
  const chunks = [];
  let chunk = '';
  for (const { segment } of pdfGraphemes.segment(token)) {
    const candidate = chunk + segment;
    if (chunk && pdfTextWidth(doc, preferredFont, candidate, options) > width) {
      chunks.push(chunk);
      chunk = segment;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function wrapPdfLogicalLines(doc, preferredFont, value, width, options = {}) {
  const wrapped = [];
  for (const sourceLine of pdfText(value).split('\n')) {
    if (!sourceLine) {
      wrapped.push('');
      continue;
    }
    let line = '';
    for (const token of sourceLine.match(/\s+|[^\s]+/gu) || []) {
      const candidate = line + token;
      if (pdfTextWidth(doc, preferredFont, candidate, options) <= width) {
        line = candidate;
        continue;
      }
      if (line.trimEnd()) wrapped.push(line.trimEnd());
      let remainder = token.trimStart();
      if (!remainder) {
        line = '';
        continue;
      }
      const chunks = splitLongPdfToken(doc, preferredFont, remainder, width, options);
      while (
        chunks.length > 1
        || (chunks.length && pdfTextWidth(doc, preferredFont, chunks[0], options) > width)
      ) {
        wrapped.push(chunks.shift());
      }
      remainder = chunks[0] || '';
      line = remainder;
    }
    wrapped.push(line.trimEnd());
  }
  return wrapped;
}

function positionPdfLineRuns(
  doc,
  preferredFont,
  line,
  x,
  width,
  align,
  options = {},
  direction,
) {
  const runs = linePdfFontRuns(preferredFont, line, direction).map(({ font, text }) => ({
    font,
    text,
    width: doc.font(font).widthOfString(text, {
      characterSpacing: options.characterSpacing || 0,
    }),
  }));
  const lineWidth = runs.reduce((total, run) => total + run.width, 0);
  let cursor = x;
  if (align === 'right') cursor += width - lineWidth;
  if (align === 'center') cursor += (width - lineWidth) / 2;
  return runs.map((run) => {
    const positioned = { ...run, x: cursor };
    cursor += run.width;
    return positioned;
  });
}

function writePositionedPdfText(doc, preferredFont, value, options) {
  const startX = doc.x;
  const width = options.width
    ?? doc.page.width - doc.page.margins.right - startX;
  pdfText(value).split('\n').forEach((sourceLine) => {
    const rtl = pdfTextIsRtl(sourceLine);
    const direction = rtl ? 'rtl' : 'ltr';
    const align = options.align || (rtl ? 'right' : 'left');
    const lines = wrapPdfLogicalLines(
      doc,
      preferredFont,
      sourceLine,
      width,
      options,
    );
    lines.forEach((line) => {
      const positioned = positionPdfLineRuns(
        doc,
        preferredFont,
        line,
        startX,
        width,
        align,
        options,
        direction,
      );
      const fonts = positioned.length
        ? positioned.map((run) => run.font)
        : [selectPdfFont(preferredFont, ' ')];
      const lineHeight = Math.max(...fonts.map((font) => (
        doc.font(font).currentLineHeight(true)
      ))) + (options.lineGap || 0);
      ensurePdfSpace(doc, lineHeight);
      const y = doc.y;
      positioned.forEach((run) => {
        doc.font(run.font).text(run.text, run.x, y, {
          characterSpacing: options.characterSpacing || 0,
          features: options.features,
          lineBreak: false,
        });
      });
      doc.x = startX;
      doc.y = y + lineHeight;
    });
  });
  return doc;
}

function writePdfText(doc, preferredFont, value, options = {}) {
  const text = pdfText(value);
  const runs = pdfFontRuns(preferredFont, text);
  if (!runs.length) return doc;
  const fontCount = new Set(runs.map((run) => run.font)).size;
  const hasRtlLine = text.split('\n').some((line) => pdfTextIsRtl(line));
  if (fontCount === 1 && !hasRtlLine) {
    return doc.font(runs[0].font).text(text, options);
  }
  return writePositionedPdfText(doc, preferredFont, text, options);
}

function pdfHeightOfString(doc, preferredFont, value, size, options) {
  const text = pdfText(value);
  const fonts = new Set(pdfFontRuns(preferredFont, text).map((run) => run.font));
  if (!fonts.size) fonts.add(selectPdfFont(preferredFont, text));
  return Math.max(...[...fonts].map((font) => (
    doc.font(font).fontSize(size).heightOfString(text, options)
  )));
}

function registerPdfFonts(doc) {
  Object.entries(PDF_FONT_FILES).forEach(([name, filePath]) => {
    doc.registerFont(name, filePath);
  });
}

function textValue(value) {
  const text = pdfText(value);
  return text === '' ? 'Not recorded' : text;
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

function pngDimensions(buffer) {
  if (buffer.length < 33) throw new Error('Invalid PNG image');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assertImageDimensions(width, height);
  return { width, height };
}

function decodePng(buffer) {
  return new Promise((resolve, reject) => {
    new PNG({ checkCRC: true }).parse(buffer, (error, decoded) => {
      if (error) reject(error);
      else resolve(decoded);
    });
  });
}

function encodePng(decoded) {
  return new Promise((resolve, reject) => {
    const output = new PNG({
      colorType: 6,
      height: decoded.height,
      inputColorType: 6,
      inputHasAlpha: true,
      width: decoded.width,
    });
    decoded.data.copy(output.data);
    const chunks = [];
    output.pack()
      .on('data', (chunk) => chunks.push(chunk))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function preparePdfImage(buffer, mediaType) {
  if (mediaType === 'image/jpeg') {
    const dimensions = jpegDimensions(buffer);
    return { buffer, ...dimensions };
  }
  if (mediaType !== 'image/png' || buffer.length < 33) {
    throw new Error('PDF image must be a JPEG or PNG');
  }
  const dimensions = pngDimensions(buffer);
  const decoded = await decodePng(buffer);
  assertImageDimensions(decoded.width, decoded.height);
  return {
    buffer: await encodePng(decoded),
    decodedBytes: decoded.width * decoded.height * 4,
    ...dimensions,
    width: decoded.width,
    height: decoded.height,
  };
}

async function safePdfImage(buffer, mediaType) {
  return (await preparePdfImage(buffer, mediaType)).buffer;
}

async function preparePdfMedia(media, limits = {}) {
  const maxImages = limits.maxImages ?? MAX_PDF_IMAGES;
  const maxTotalPixels = limits.maxTotalPixels ?? MAX_PDF_TOTAL_PIXELS;
  const maxDecodedBytes = limits.maxDecodedBytes ?? MAX_PDF_DECODED_BYTES;
  const prepareImage = limits.prepareImage || preparePdfImage;
  let candidateCount = 0;
  let totalDecodedBytes = 0;
  let totalPixels = 0;
  const preparedByPath = new Map();
  const prepared = [];
  for (const item of media) {
    const result = { ...item };
    const mediaType = item.mediaType || item.record?.media_type;
    const reuseKey = item.buffer && item.archivePath ? item.archivePath : null;
    if (reuseKey && preparedByPath.has(reuseKey)) {
      Object.assign(result, preparedByPath.get(reuseKey));
      prepared.push(result);
      continue;
    }
    if (!item.buffer || !['image/jpeg', 'image/png'].includes(mediaType)) {
      if (reuseKey) preparedByPath.set(reuseKey, {});
      prepared.push(result);
      continue;
    }
    candidateCount += 1;
    if (candidateCount > maxImages) {
      result.pdfStatus = 'skipped-image-count-budget';
      prepared.push(result);
      continue;
    }
    try {
      const dimensions = mediaType === 'image/jpeg'
        ? jpegDimensions(item.buffer)
        : pngDimensions(item.buffer);
      const pixels = dimensions.width * dimensions.height;
      const decodedBytes = mediaType === 'image/png' ? pixels * 4 : 0;
      if (totalPixels + pixels > maxTotalPixels) {
        result.pdfStatus = 'skipped-total-pixel-budget';
      } else if (totalDecodedBytes + decodedBytes > maxDecodedBytes) {
        result.pdfStatus = 'skipped-decoded-byte-budget';
      } else {
        const preparedImage = await prepareImage(item.buffer, mediaType);
        const actualPixels = preparedImage.width * preparedImage.height;
        const actualDecodedBytes = mediaType === 'image/png'
          ? preparedImage.width * preparedImage.height * 4
          : 0;
        if (
          totalPixels + actualPixels > maxTotalPixels
          || totalDecodedBytes + actualDecodedBytes > maxDecodedBytes
        ) {
          result.pdfStatus = actualDecodedBytes > 0
            ? 'skipped-decoded-byte-budget'
            : 'skipped-total-pixel-budget';
        } else {
          result.pdfBuffer = preparedImage.buffer;
          result.pdfHeight = preparedImage.height;
          result.pdfStatus = 'included';
          result.pdfWidth = preparedImage.width;
          totalPixels += actualPixels;
          totalDecodedBytes += actualDecodedBytes;
        }
      }
    } catch {
      result.pdfStatus = 'invalid-or-unsupported';
    }
    if (reuseKey) {
      preparedByPath.set(reuseKey, {
        ...(result.pdfBuffer ? { pdfBuffer: result.pdfBuffer } : {}),
        ...(result.pdfHeight ? { pdfHeight: result.pdfHeight } : {}),
        ...(result.pdfStatus ? { pdfStatus: result.pdfStatus } : {}),
        ...(result.pdfWidth ? { pdfWidth: result.pdfWidth } : {}),
      });
    }
    prepared.push(result);
  }
  return prepared;
}

const PDF_COLORS = Object.freeze({
  blush: '#fbf3f4',
  ink: '#3d2a2f',
  line: '#ead5da',
  muted: '#825f69',
  rose: '#bd4960',
  white: '#ffffff',
});

function ensurePdfSpace(doc, requiredHeight) {
  const printableBottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + requiredHeight > printableBottom) {
    doc.addPage();
    return true;
  }
  return false;
}

function reservePdfItem(doc, textBlocks, imageHeight = 0) {
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const printableHeight = doc.page.height
    - doc.page.margins.top
    - doc.page.margins.bottom;
  const textHeight = textBlocks.reduce((height, block) => {
    return height + pdfHeightOfString(doc, block.font, textValue(block.text), block.size, {
      lineGap: block.lineGap || 0,
      width,
    }) + (block.gap || 0);
  }, 0);
  const requestedHeight = textHeight + imageHeight + 18;
  const minimumOpening = Math.min(requestedHeight, 118);
  ensurePdfSpace(
    doc,
    requestedHeight <= printableHeight ? requestedHeight : minimumOpening,
  );
}

function embedPdfImage(doc, buffer, options, unavailableText) {
  try {
    const { x, y, ...imageOptions } = options;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      doc.image(buffer, x, y, imageOptions);
    } else {
      doc.image(buffer, imageOptions);
    }
    return true;
  } catch {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(PDF_COLORS.muted)
      .text(unavailableText);
    return false;
  }
}

function pdfParagraphs(doc, paragraphs, options = {}) {
  const font = options.font || 'Times-Roman';
  const size = options.size || 11.5;
  paragraphs.forEach((paragraph, index) => {
    doc.fontSize(size).fillColor(options.color || PDF_COLORS.ink);
    writePdfText(doc, font, paragraph, { lineGap: options.lineGap ?? 2.5 });
    if (index < paragraphs.length - 1) doc.moveDown(options.gap ?? 0.65);
  });
}

function pdfEntryHeading(doc, date, title) {
  doc.fontSize(8.5).fillColor(PDF_COLORS.rose);
  writePdfText(
    doc,
    'Helvetica-Bold',
    pdfText(date || 'A moment to remember').toUpperCase(),
    { characterSpacing: 0.8 },
  );
  doc.moveDown(0.35);
  doc.fontSize(18).fillColor(PDF_COLORS.ink);
  writePdfText(doc, 'Times-Bold', textValue(title || 'A shared moment'), { lineGap: 1 });
  doc.moveDown(0.55);
}

function pdfPhotoMessage(doc, message) {
  ensurePdfSpace(doc, 54);
  const x = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.y;
  doc.roundedRect(x, y, width, 42, 3).fill(PDF_COLORS.blush);
  doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(PDF_COLORS.muted)
    .text(message, x + 14, y + 13, { width: width - 28 });
  doc.y = y + 52;
}

function pdfImageLayout(doc, item) {
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const sourceWidth = item.pdfWidth || 1;
  const sourceHeight = item.pdfHeight || 1;
  const portrait = sourceHeight > sourceWidth * 1.08;
  const maxWidth = Math.min(availableWidth, portrait ? 340 : 450);
  const maxHeight = portrait ? 370 : 285;
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    height: Math.max(1, sourceHeight * scale),
    width: Math.max(1, sourceWidth * scale),
  };
}

function renderPdfPhoto(doc, portablePhotoData, item, caption) {
  if (!portablePhotoData) return;
  if (portablePhotoData.status !== 'available' || !item?.buffer) {
    pdfPhotoMessage(doc, 'This photo was unavailable when the keepsake was created.');
    return;
  }
  if (!item.pdfBuffer) {
    const message = item.pdfStatus?.startsWith('skipped-')
      ? 'This photo could not be placed in the PDF, but it remains in the printable keepsake.'
      : 'This photo is preserved in the printable keepsake but could not be displayed on this page.';
    pdfPhotoMessage(doc, message);
    return;
  }
  const layout = pdfImageLayout(doc, item);
  const captionText = normalizeUserText(caption) || 'A shared moment';
  ensurePdfSpace(doc, layout.height + 42);
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x = doc.page.margins.left + (contentWidth - layout.width) / 2;
  const y = doc.y;
  const embedded = embedPdfImage(doc, item.pdfBuffer, {
    fit: [layout.width, layout.height],
    x,
    y,
  }, 'This photo could not be displayed, but its caption remains.');
  if (embedded) {
    doc.y = y + layout.height + 8;
    doc.fontSize(8.5).fillColor(PDF_COLORS.muted);
    writePdfText(doc, 'Helvetica-Oblique', captionText, {
      align: 'center',
      width: contentWidth,
    });
    doc.moveDown(0.7);
  }
}

function addPdfSection(doc, chapter, title, introduction, items, emptyMessage, renderItem) {
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(PDF_COLORS.rose)
    .text(`CHAPTER ${String(chapter).padStart(2, '0')}`, {
      characterSpacing: 1.4,
    });
  doc.moveDown(0.45);
  doc.font('Times-Roman').fontSize(29).fillColor(PDF_COLORS.ink).text(pdfText(title));
  doc.moveDown(0.3);
  doc.font('Times-Italic').fontSize(11).fillColor(PDF_COLORS.muted)
    .text(pdfText(introduction));
  doc.moveDown(0.8);
  const lineY = doc.y;
  doc.moveTo(doc.page.margins.left, lineY)
    .lineTo(doc.page.width - doc.page.margins.right, lineY)
    .lineWidth(1.2)
    .strokeColor(PDF_COLORS.rose)
    .stroke();
  doc.y = lineY + 18;
  if (!items.length) {
    pdfPhotoMessage(doc, emptyMessage);
    return;
  }
  items.forEach((item, index) => {
    if (index > 0) {
      ensurePdfSpace(doc, 90);
      const dividerY = doc.y + 5;
      doc.moveTo(doc.page.margins.left, dividerY)
        .lineTo(doc.page.width - doc.page.margins.right, dividerY)
        .lineWidth(0.5)
        .strokeColor(PDF_COLORS.line)
        .stroke();
      doc.y = dividerY + 18;
    }
    renderItem(item);
  });
}

async function buildPdf(exportData, media, limits = {}) {
  const pdfMedia = await preparePdfMedia(media, limits);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    const doc = new PDFDocument({
      bufferPages: true,
      compress: false,
      info: {
        Title: 'Our GBAGL Keepsake',
        Author: 'GBAGL',
        Subject: 'A keepsake of our shared story',
      },
      margins: { top: 58, right: 58, bottom: 64, left: 58 },
      size: 'LETTER',
    });
    registerPdfFonts(doc);
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

    const [first, second] = exportData.relationship.partners;
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(PDF_COLORS.blush);
    doc.y = 188;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PDF_COLORS.rose)
      .text('A KEEPSAKE OF OUR STORY', {
        align: 'center',
        characterSpacing: 1.7,
      });
    doc.moveDown(1.25);
    doc.font('Times-Roman').fontSize(38).fillColor(PDF_COLORS.ink).text('Our GBAGL Keepsake', {
      align: 'center',
    });
    const coverRuleY = doc.y + 20;
    doc.moveTo(doc.page.width / 2 - 42, coverRuleY)
      .lineTo(doc.page.width / 2 + 42, coverRuleY)
      .lineWidth(1.3)
      .strokeColor(PDF_COLORS.rose)
      .stroke();
    doc.y = coverRuleY + 26;
    const partnerNames = `${textValue(first)} & ${textValue(second)}`;
    doc.fontSize(21).fillColor(PDF_COLORS.ink);
    writePdfText(doc, 'Times-Italic', partnerNames, { align: 'center' });
    if (exportData.relationship.anniversary) {
      doc.moveDown(0.8);
      doc.font('Helvetica').fontSize(9.5).fillColor(PDF_COLORS.muted)
        .text(`Together since ${pdfText(formatDisplayDate(exportData.relationship.anniversary))}`, {
          align: 'center',
        });
    }
    doc.font('Helvetica').fontSize(8.5).fillColor(PDF_COLORS.muted)
      .text(
        `Created ${pdfText(formatDisplayDate(
          exportData.createdAt,
          false,
          exportData.relationship.timezone,
        ))}`,
        58,
        doc.page.height - 82,
        { align: 'center', lineBreak: false, width: doc.page.width - 116 },
      );

    const mediaByPath = new Map(pdfMedia
      .filter((item) => item.archivePath)
      .map((item) => [item.archivePath, item]));
    const matchingMedia = (photo) => (
      photo?.file ? mediaByPath.get(photo.file) : null
    );
    addPdfSection(
      doc,
      1,
      'Our Timeline',
      'The moments that shaped our story.',
      exportData.timeline,
      'Our next Timeline moment is still waiting to be added.',
      (item) => {
        const image = matchingMedia(item.photo);
        const description = splitParagraphs(item.description);
        const imageHeight = image?.pdfBuffer ? pdfImageLayout(doc, image).height + 42 : 54;
        reservePdfItem(doc, [
          { font: 'Helvetica-Bold', size: 8.5, text: formatDisplayDate(item.date) },
          { font: 'Times-Bold', size: 18, text: item.title, gap: 6 },
          ...(description[0]
            ? [{ font: 'Times-Roman', size: 11.5, text: description[0], lineGap: 2.5 }]
            : []),
        ], imageHeight);
        pdfEntryHeading(
          doc,
          formatDisplayDate(item.date) || item.date,
          item.title || 'A shared moment',
        );
        pdfParagraphs(doc, description);
        if (description.length) doc.moveDown(0.6);
        renderPdfPhoto(doc, item.photo, image, item.title);
      },
    );

    addPdfSection(
      doc,
      2,
      'Letters & Journal',
      'Words, reflections, and photos from along the way.',
      exportData.journals,
      'The first Journal letter is still waiting to be written.',
      (item) => {
        const letter = journalLetterParts(item.body);
        const opening = [...letter.salutation, ...letter.body, ...letter.signoff][0];
        reservePdfItem(doc, [
          { font: 'Helvetica-Bold', size: 8.5, text: formatDisplayDate(item.date) },
          { font: 'Times-Bold', size: 18, text: item.title, gap: 6 },
          ...(opening ? [{ font: 'Times-Roman', size: 11.5, text: opening, lineGap: 2.5 }] : []),
        ]);
        pdfEntryHeading(
          doc,
          formatDisplayDate(item.date) || 'Journal letter',
          item.title || 'A letter from the heart',
        );
        pdfParagraphs(doc, letter.salutation, { font: 'Times-Italic', gap: 0.8 });
        if (letter.salutation.length && (letter.body.length || letter.signoff.length)) {
          doc.moveDown(0.7);
        }
        pdfParagraphs(doc, letter.body);
        if (letter.body.length && letter.signoff.length) doc.moveDown(0.9);
        pdfParagraphs(doc, letter.signoff, { font: 'Times-Italic', gap: 0.35 });
        if (item.body) doc.moveDown(0.8);
        item.photos.forEach((photo) => {
          const image = matchingMedia(photo);
          renderPdfPhoto(doc, photo, image, photo.caption || item.title);
        });
      },
    );

    addPdfSection(
      doc,
      3,
      'Bucket Memories',
      'Adventures we dreamed about and made real.',
      exportData.bucketMemories,
      'Completed adventures will become memories here.',
      (item) => {
        const paragraphs = splitParagraphs(item.memory || item.description);
        reservePdfItem(doc, [
          { font: 'Helvetica-Bold', size: 8.5, text: formatDisplayDate(item.completedDate) },
          { font: 'Times-Bold', size: 18, text: item.title, gap: 6 },
          ...(paragraphs[0]
            ? [{ font: 'Times-Roman', size: 11.5, text: paragraphs[0], lineGap: 2.5 }]
            : []),
        ]);
        pdfEntryHeading(
          doc,
          formatDisplayDate(item.completedDate) || 'Adventure completed',
          item.title || 'A shared adventure',
        );
        pdfParagraphs(doc, paragraphs);
        doc.moveDown(0.7);
      },
    );

    addPdfSection(
      doc,
      4,
      'Shared Events',
      'Dates and plans that belong to our story.',
      exportData.sharedEvents,
      'There are no shared events in this keepsake yet.',
      (item) => {
        const paragraphs = splitParagraphs(item.notes);
        reservePdfItem(doc, [
          {
            font: 'Helvetica-Bold',
            size: 8.5,
            text: formatDisplayDate(item.date, true, exportData.relationship.timezone),
          },
          { font: 'Times-Bold', size: 18, text: item.title, gap: 6 },
          ...(paragraphs[0]
            ? [{ font: 'Times-Roman', size: 11.5, text: paragraphs[0], lineGap: 2.5 }]
            : []),
        ]);
        pdfEntryHeading(
          doc,
          formatDisplayDate(item.date, true, exportData.relationship.timezone) || 'A shared date',
          item.title || 'Time together',
        );
        pdfParagraphs(doc, paragraphs);
        doc.moveDown(0.7);
      },
    );

    const range = doc.bufferedPageRange();
    const numberedPages = Math.max(0, range.count - 1);
    for (let index = range.start + 1; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      const footerY = doc.page.height - 36;
      doc.moveTo(doc.page.margins.left, footerY - 8)
        .lineTo(doc.page.width - doc.page.margins.right, footerY - 8)
        .lineWidth(0.45)
        .strokeColor(PDF_COLORS.line)
        .stroke();
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor(PDF_COLORS.muted)
        .text(
          `OUR GBAGL KEEPSAKE  |  ${index} OF ${numberedPages}`,
          doc.page.margins.left,
          footerY,
          {
            align: 'center',
            characterSpacing: 0.6,
            lineBreak: false,
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          },
        );
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
  });
}

function collectArchive(archive) {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (typeof archive.abort === 'function') archive.abort();
      if (!output.destroyed) output.destroy();
      reject(error);
    };
    output.on('data', (chunk) => {
      byteLength += chunk.length;
      if (byteLength > MAX_OUTPUT_BYTES) {
        fail(new Error('ZIP export exceeded the output limit'));
        return;
      }
      chunks.push(chunk);
    });
    output.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    output.on('error', fail);
    archive.on('error', fail);
    archive.pipe(output);
  });
}

async function buildZip(exportData, media) {
  const mediaToArchive = [];
  const archivedPaths = new Set();
  media.filter((item) => item.buffer && item.archivePath).forEach((item) => {
    const archivePath = safeArchiveName(item.archivePath);
    if (archivedPaths.has(archivePath)) return;
    archivedPaths.add(archivePath);
    mediaToArchive.push({ archivePath, buffer: item.buffer });
  });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const result = collectArchive(archive);
  try {
    archive.append(buildPrintableHtml(exportData), {
      name: safeArchiveName('Keepsake.html'),
    });
    archive.append(JSON.stringify(exportData, null, 2), {
      name: safeArchiveName('Keepsake.json'),
    });
    mediaToArchive.forEach((item) => {
      archive.append(item.buffer, { name: item.archivePath });
    });
    await archive.finalize();
    return await result;
  } catch (error) {
    if (typeof archive.abort === 'function') archive.abort();
    throw error;
  }
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
  embedPdfImage,
  ensurePdfSpace,
  formatDisplayDate,
  journalLetterParts,
  loadKeepsakeData,
  loadExportMedia,
  mediaArchiveName,
  normalizeUserText,
  pdfFontRuns,
  pdfImageLayout,
  pdfText,
  positionPdfLineRuns,
  preparePdfMedia,
  publicExportData,
  reservePdfItem,
  safePdfImage,
  safeArchiveName,
  selectPdfFont,
  wrapPdfLogicalLines,
  writePdfText,
};
