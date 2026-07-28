const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { PNG } = require('pngjs');
const {
  buildPdf,
  buildPrintableHtml,
  buildZip,
  embedPdfImage,
  ensurePdfSpace,
  loadExportMedia,
  loadKeepsakeData,
  mediaArchiveName,
  normalizeUserText,
  pdfFontRuns,
  pdfImageLayout,
  pdfText,
  positionPdfLineRuns,
  preparePdfMedia,
  publicExportData,
  reservePdfItem,
  safeArchiveName,
  safePdfImage,
  selectPdfFont,
  wrapPdfLogicalLines,
  writePdfText,
} = require('../services/keepsakeExport');
const { createExportRouter, exportFilename } = require('../routes/exports');

function sampleExportData() {
  return {
    formatVersion: 3,
    createdAt: '2026-07-20T05:00:00.000Z',
    relationship: {
      partners: ['Alex', 'Jordan'],
      anniversary: '2020-02-29',
      timezone: 'America/Los_Angeles',
    },
    timeline: [{
      date: 'Spring 2020',
      title: 'First trip',
      description: 'A memorable beginning',
      emoji: '',
      photo: null,
    }],
    journals: [{
      title: 'Looking back',
      body: 'Dear Alex,\n\nStill smiling.\n\nWith love,\nJordan',
      date: '2026-01-02',
      photos: [{
        caption: 'At the water',
        date: '2025-07-04',
        status: 'unavailable',
      }],
    }],
    bucketMemories: [{
      title: 'See the coast',
      description: 'Drive west',
      category: 'travel',
      targetDate: '2025-06-01',
      completedDate: '2025-07-04',
      memory: 'Sunset together',
    }],
    sharedEvents: [{
      title: 'Dinner',
      date: '2026-08-01T02:00:00Z',
      reminder: '2026-08-01T01:00:00Z',
      notes: 'Window table',
      completed: false,
    }],
  };
}

function sampleRawData() {
  return {
    settings: {
      partner_one_name: 'Alex',
      partner_two_name: 'Jordan',
      anniversary_date: '2020-02-29',
      timezone: 'America/Los_Angeles',
    },
    timeline: [{
      id: 91,
      milestone_date: '2020-05-02',
      title: 'First trip',
      description: 'A memorable beginning',
      emoji: '🌊',
      photo: `${'a'.repeat(32)}.jpg`,
    }],
    journals: [{
      id: 92,
      title: 'Looking back',
      body: 'Dear Alex,\n\nStill smiling.\n\nWith love,\nJordan',
      entry_date: '2026-01-02',
    }],
    photos: [{
      id: 93,
      journal_entry_id: 92,
      caption: 'At the water',
      photo_date: '2025-07-04',
      media_type: 'image/jpeg',
    }],
    completedBucketItems: [{
      id: 94,
      title: 'See the coast',
      description: 'Drive west',
      category: 'travel',
      target_date: '2025-06-01',
      completed_at: '2025-07-04',
      memory: 'Sunset together',
    }],
    events: [{
      id: 95,
      title: 'Dinner',
      event_at: '2026-08-01T02:00:00Z',
      reminder_at: '2026-08-01T01:00:00Z',
      notes: 'Window table',
      is_completed: 0,
    }],
  };
}

function zipEntries(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, 'ZIP end record should exist');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(compressed) : compressed);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractedPdfText(pdf) {
  return [...pdf.toString('latin1').matchAll(/\[((?:.|\r|\n)*?)\]\s*TJ/g)]
    .map((operation) => [...operation[1].matchAll(/<([0-9a-f]+)>/gi)]
      .map((match) => Buffer.from(match[1], 'hex').toString('latin1'))
      .join('')
      .replace(/[\x80-\x9f]/g, (character) => ({
        '\x85': '\u2026',
        '\x91': '\u2018',
        '\x92': '\u2019',
        '\x93': '\u201c',
        '\x94': '\u201d',
        '\x96': '\u2013',
        '\x97': '\u2014',
      }[character] || character)))
    .join(' ');
}

function htmlProse(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

test('generated photo names are descriptive, collision-safe, and reject zip-slip input', () => {
  const usedNames = new Set();
  assert.equal(
    mediaArchiveName({
      caption: 'At the water!',
      id: 6,
      journal_entry_id: 2,
      media_type: 'image/png',
      photo_date: '2025-07-04',
    }, usedNames),
    'Photos/2025-07-04-at-the-water.png',
  );
  assert.equal(
    mediaArchiveName({
      caption: 'At the water!',
      id: 7,
      journal_entry_id: 2,
      media_type: 'image/png',
      photo_date: '2025-07-04',
    }, usedNames),
    'Photos/2025-07-04-at-the-water-2.png',
  );
  assert.equal(safeArchiveName('Photos/a-memory.jpg'), 'Photos/a-memory.jpg');
  for (const invalid of ['../secret', '/absolute', 'media\\photo.jpg', 'media//photo.jpg']) {
    assert.throws(() => safeArchiveName(invalid), /Invalid generated archive/);
  }
});

test('printable HTML and ZIP are readable keepsakes without technical path prose', async () => {
  const data = sampleExportData();
  const html = buildPrintableHtml(data);
  assert.match(html, /Alex &amp; Jordan/);
  assert.match(html, /Spring 2020/);
  assert.match(html, /July 31, 2026 at 7:00 PM/);
  assert.match(html, /Sunset together/);
  assert.match(html, /Dear Alex,/);
  assert.match(html, /letter__salutation|letter__signoff/);
  assert.match(html, /This photo was unavailable when the keepsake was created/);
  assert.doesNotMatch(htmlProse(html), /Photos\/|media\/|archive|record ID|upload/i);
  assert.doesNotMatch(html, /runtime[\\/]uploads|storage_name|DB_PASSWORD/);

  const zip = await buildZip(data, []);
  assert.equal(zip.subarray(0, 2).toString('ascii'), 'PK');
  const entries = zipEntries(zip);
  assert.deepEqual([...entries.keys()].sort(), ['Keepsake.html', 'Keepsake.json']);
  assert.doesNotMatch(entries.get('Keepsake.json').toString('utf8'), /"id"|archive_path|storage_name/);
});

test('user content normalization preserves paragraphs, tabs, names, and portable Unicode', () => {
  const input = 'Cafe\u0301\r\n\rSecond\u2028third\u2029fourth\tcolumn'
    + '\u0000\u0008\u202e\n\u00d0\n\n'
    + 'We\u00e2\u20ac\u2122re \u00f0\u0178\u02dc\u0160';
  const normalized = normalizeUserText(input);

  assert.match(normalized, /^Caf\u00e9\n\nSecond\nthird\nfourth\tcolumn/);
  assert.match(normalized, /We\u2019re \ud83d\ude0a$/u);
  assert.doesNotMatch(normalized, /\r|\u2028|\u2029|\u0000|\u0008|\u202e|\u00d0|\u00e2|\u00f0/u);
  assert.equal(normalizeUserText('Ren\u00e9e \ud83d\ude0a \u6771\u4eac'), 'Ren\u00e9e \ud83d\ude0a \u6771\u4eac');
  assert.equal(
    normalizeUserText('Fran\u00c3\u0192\u00c2\u00a7ois'),
    'Fran\u00e7ois',
  );
  assert.equal(normalizeUserText('FranA\u0303\u00a7ois'), 'Fran\u00e7ois');
  assert.equal(normalizeUserText('Fran\u00c3\u200b\u00a7ois'), 'Fran\u00e7ois');
  assert.equal(normalizeUserText(normalized), normalized);
  assert.equal(
    pdfText('\u201cWe\u2019re\u201d \u2014 Ren\u00e9e \ud83d\ude0a').trim(),
    '\u201cWe\u2019re\u201d \u2014 Ren\u00e9e',
  );
});

test('PDF font selection preserves non-Western names and writing systems', async () => {
  assert.equal(selectPdfFont('Times-Roman', '\u041c\u0430\u0440\u0438\u044f'), 'KeepsakeSerif');
  assert.equal(selectPdfFont('Times-Roman', '\u0639\u0644\u064a'), 'KeepsakeSans');
  assert.equal(selectPdfFont('Times-Italic', '\u0639\u0644\u064a'), 'KeepsakeSans');
  assert.equal(selectPdfFont('Times-Roman', '\u6771\u4eac'), 'KeepsakeFallback');
  assert.deepEqual(pdfFontRuns('Times-Roman', 'q\u0307'), [
    { font: 'KeepsakeSerif', text: 'q\u0307' },
  ]);
  assert.deepEqual(pdfFontRuns('Times-Italic', '\u0639\u0644\u064a & \u6771\u4eac'), [
    { font: 'KeepsakeFallback', text: '\u6771\u4eac' },
    { font: 'KeepsakeSans', text: '\u0639\u0644\u064a & ' },
  ]);
  const measuringDoc = {
    font() { return this; },
    widthOfString(value) { return [...value].length * 10; },
  };
  const positioned = positionPdfLineRuns(
    measuringDoc,
    'Times-Italic',
    '\u0639\u0644\u064a & \u6771\u4eac',
    0,
    300,
    'right',
  );
  assert.deepEqual(positioned.map((run) => run.x), [220, 240]);
  assert.ok(positioned[0].x + positioned[0].width <= positioned[1].x);
  assert.equal(positioned.at(-1).x + positioned.at(-1).width, 300);

  const wrapped = wrapPdfLogicalLines(
    measuringDoc,
    'Times-Roman',
    '\u0627\u0644\u0628\u062f\u0627\u064a\u0629 \u0627\u0644\u0628\u062f\u0627\u064a\u0629 \u6771\u4eac \u0627\u0644\u0646\u0647\u0627\u064a\u0629 \u0627\u0644\u0646\u0647\u0627\u064a\u0629',
    150,
  );
  assert.match(wrapped[0], /^\u0627\u0644\u0628\u062f\u0627\u064a\u0629/);
  assert.doesNotMatch(wrapped[0], /\u0627\u0644\u0646\u0647\u0627\u064a\u0629/);
  assert.match(wrapped.at(-1), /\u0627\u0644\u0646\u0647\u0627\u064a\u0629$/);
  const continuation = positionPdfLineRuns(
    measuringDoc,
    'Times-Roman',
    'Tokyo \u0639\u0644\u064a',
    0,
    150,
    'right',
    {},
    'rtl',
  );
  assert.equal(continuation[0].text, '\u0639\u0644\u064a');
  assert.equal(continuation.slice(1).map((run) => run.text).join(''), ' Tokyo');
  const draws = [];
  const drawingDoc = {
    page: {
      height: 1000,
      margins: { bottom: 0, left: 0, right: 0, top: 0 },
      width: 300,
    },
    x: 0,
    y: 0,
    addPage() { this.y = 0; return this; },
    currentLineHeight() { return 10; },
    font() { return this; },
    text(text, x, y) {
      draws.push({ text, x, y });
      return this;
    },
    widthOfString(value) { return [...value].length * 10; },
  };
  writePdfText(
    drawingDoc,
    'Times-Roman',
    'English\n\u0639\u0644\u064a & \u6771\u4eac',
    { width: 300 },
  );
  assert.deepEqual(draws.filter((draw) => draw.y === 0).map((draw) => draw.text), ['English']);
  assert.equal(draws.find((draw) => draw.y === 10).text, '\u6771\u4eac');
  assert.ok(draws.find((draw) => draw.y === 10).x > 0);
  assert.equal(pdfText('\u6771\u4eac \ud83d\ude0a').trim(), '\u6771\u4eac');

  const data = sampleExportData();
  data.relationship.partners = ['\u041c\u0430\u0440\u0438\u044f', '\u6771\u4eac \ud83d\ude0a'];
  data.journals[0].body = '\u0639\u0644\u064a\n\n\u0645\u0639 \u0627\u0644\u062d\u0628';
  const pdf = await buildPdf(data, []);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.match(pdf.toString('latin1'), /\/ToUnicode/);
});

test('public export data removes database and storage details without flattening content', () => {
  const raw = sampleRawData();
  raw.settings.partner_one_name = 'Ren\u00e9e';
  raw.settings.partner_two_name = '\u6771\u4eac \ud83d\ude0a';
  raw.journals[0].body = 'Dear Ren\u00e9e,\r\n\r\nWe\u00e2\u20ac\u2122re here.\u2029\u2029With love,\rJordan';
  const media = [
    {
      archivePath: 'Photos/first-trip.jpg',
      kind: 'timeline',
      mediaType: 'image/jpeg',
      record: raw.timeline[0],
      status: 'included',
    },
    {
      archivePath: 'Photos/at-the-water.jpg',
      kind: 'journal-photo',
      mediaType: 'image/jpeg',
      record: raw.photos[0],
      status: 'included',
    },
  ];

  const exported = publicExportData(raw, media, new Date('2026-07-20T05:00:00Z'));
  const json = JSON.stringify(exported);
  const html = buildPrintableHtml(exported);
  assert.deepEqual(exported.relationship.partners, ['Ren\u00e9e', '\u6771\u4eac \ud83d\ude0a']);
  assert.match(exported.journals[0].body, /Dear Ren\u00e9e,\n\nWe\u2019re here\.\n\nWith love,\nJordan/);
  assert.equal(exported.timeline[0].emoji, '\ud83c\udf0a');
  assert.equal(exported.timeline[0].photo.file, 'Photos/first-trip.jpg');
  assert.match(html, /\u6771\u4eac \ud83d\ude0a/u);
  assert.match(html, /\ud83c\udf0a/u);
  assert.doesNotMatch(json, /"id"|display_order|storage|milestone_id|a{32}\.jpg/);
});

test('Journal letters keep intentional spacing and clean PDF-safe punctuation', async () => {
  const raw = sampleRawData();
  raw.journals[0].title = '\u201cAlways us\u201d';
  raw.journals[0].body = 'Dear Alex,\r\n\r\nFirst line.\rSecond line.\u2028Still together.'
    + '\u2029\u2029\u00d0\r\n\r\nWith love,\r\nJordan';
  const exported = publicExportData(raw, [], new Date('2026-07-20T05:00:00Z'));
  const html = buildPrintableHtml(exported);
  const pdf = await buildPdf(exported, []);
  const prose = extractedPdfText(pdf);

  assert.match(html, /class="letter__salutation">Dear Alex,/);
  assert.match(html, /First line\.<br>Second line\.<br>Still together\./);
  assert.match(html, /class="letter__signoff">With love,<br>Jordan/);
  assert.match(html, /\u201cAlways us\u201d/);
  assert.doesNotMatch(htmlProse(html), /\u00d0|\u00e2\u20ac|runtime\/uploads|Photos\//);
  assert.match(prose, /\u201cAlways us\u201d/);
  assert.match(prose, /Dear Alex,/);
  assert.match(prose, /With love,/);
  assert.doesNotMatch(prose, /\u00d0|\u00e2\u20ac|Photos\/|media\//);
});

test('duplicate Timeline and Journal media is stored once with shared portable references', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const uploadDir = path.join(__dirname, 'virtual-deduplicated-uploads');
  const raw = sampleRawData();
  raw.photos[0].storage_name = `${'b'.repeat(32)}.jpg`;
  raw.photos[0].storage_type = 'upload';
  raw.timeline[0].photo_storage_type = 'upload';
  raw.timeline[0].photo_media_type = 'image/jpeg';
  const media = await loadExportMedia(
    { uploadDir },
    raw.photos,
    raw.timeline,
    {
      boundedRegularFile: async (filePath) => ({ path: filePath, size: jpeg.length }),
      readFile: async () => jpeg,
    },
  );
  assert.equal(media.length, 2);
  assert.equal(media[0].archivePath, media[1].archivePath);

  const exported = publicExportData(raw, media, new Date('2026-07-20T05:00:00Z'));
  assert.equal(exported.timeline[0].photo.file, exported.journals[0].photos[0].file);
  const entries = zipEntries(await buildZip(exported, media));
  assert.equal([...entries.keys()].filter((name) => name.startsWith('Photos/')).length, 1);
});

test('missing and unsupported Timeline photos stay path-free and human-readable', async () => {
  const raw = sampleRawData();
  raw.photos = [];
  raw.timeline = [
    {
      id: 101,
      milestone_date: '2024-03-01',
      photo: 'images/private-memory.bmp',
      photo_storage_type: 'existing',
      title: 'Unsupported memory',
    },
    {
      id: 102,
      milestone_date: '2024-04-01',
      photo: `${'c'.repeat(32)}.jpg`,
      photo_media_type: 'image/jpeg',
      photo_storage_type: 'upload',
      title: 'Missing memory',
    },
  ];
  const media = await loadExportMedia(
    {
      publicDir: path.join(__dirname, 'virtual-unsupported-public'),
      uploadDir: path.join(__dirname, 'virtual-missing-uploads'),
    },
    [],
    raw.timeline,
    {
      boundedRegularFile: async () => {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
      readFile: async () => {
        throw new Error('unreachable');
      },
    },
  );
  assert.deepEqual(media.map((item) => ({
    archivePath: item.archivePath,
    status: item.status,
  })), [
    { archivePath: null, status: 'missing-or-unreadable' },
    { archivePath: null, status: 'missing-or-unreadable' },
  ]);

  const exported = publicExportData(raw, media, new Date('2026-07-20T05:00:00Z'));
  const html = buildPrintableHtml(exported);
  const pdfProse = extractedPdfText(await buildPdf(exported, media));
  assert.deepEqual(exported.timeline.map((item) => item.photo), [
    { status: 'unavailable' },
    { status: 'unavailable' },
  ]);
  assert.match(htmlProse(html), /photo was unavailable/i);
  assert.match(pdfProse, /photo was unavailable/i);
  assert.doesNotMatch(
    `${htmlProse(html)} ${pdfProse} ${JSON.stringify(exported)}`,
    /private-memory\.bmp|c{32}\.jpg|runtime[\\/]uploads|Photos\/|record ID/i,
  );
});

test('invalid media does not consume the validated aggregate byte budget', async () => {
  const valid = Buffer.alloc(21 * 1024 * 1024);
  valid.set([0xff, 0xd8, 0xff]);
  const corrupt = Buffer.alloc(25 * 1024 * 1024);
  const buffers = new Map();
  const photos = Array.from({ length: 6 }, (_, index) => {
    const storageName = `${String(index + 1).padStart(32, '0')}.jpg`;
    buffers.set(storageName, index === 5 ? corrupt : valid);
    return {
      journal_entry_id: 2,
      id: index + 1,
      media_type: 'image/jpeg',
      storage_name: storageName,
      storage_type: 'upload',
    };
  });

  test('keepsake media resolves uploaded and deployment-local Timeline photos', async () => {
    const uploadName = `${'a'.repeat(32)}.jpg`;
    const uploadDir = path.join(__dirname, 'virtual-timeline-uploads');
    const publicDir = path.join(__dirname, 'virtual-timeline-public');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const webp = Buffer.from('RIFF0000WEBP', 'ascii');
    const buffers = new Map([
      [uploadName, jpeg],
      ['legacy.webp', webp],
    ]);
    const inspectedRoots = [];

    const media = await loadExportMedia(
      { publicDir, uploadDir },
      [],
      [
        {
          id: 7,
          milestone_date: '2025-06-01',
          photo: uploadName,
          photo_media_type: 'image/jpeg',
          photo_storage_type: 'upload',
          title: 'Sunset picnic',
        },
        {
          id: 8,
          milestone_date: '2025-07-04',
          photo: 'images/legacy.webp',
          photo_media_type: null,
          photo_storage_type: 'existing',
          title: 'Coast drive',
        },
      ],
      {
        boundedRegularFile: async (filePath, root) => {
          inspectedRoots.push(root);
          return {
            path: filePath,
            size: buffers.get(path.basename(filePath)).length,
          };
        },
        readFile: async (filePath) => buffers.get(path.basename(filePath)),
      },
    );

    assert.deepEqual(media.map((item) => ({
      archivePath: item.archivePath,
      mediaType: item.mediaType,
      status: item.status,
    })), [
      {
        archivePath: 'Photos/2025-06-01-sunset-picnic.jpg',
        mediaType: 'image/jpeg',
        status: 'included',
      },
      {
        archivePath: 'Photos/2025-07-04-coast-drive.webp',
        mediaType: 'image/webp',
        status: 'included',
      },
    ]);
    assert.deepEqual(inspectedRoots, [
      path.resolve(uploadDir),
      path.resolve(publicDir),
    ]);
  });
  const dependencies = {
    boundedRegularFile: async (filePath) => ({
      path: filePath,
      size: buffers.get(path.basename(filePath)).length,
    }),
    readFile: async (filePath) => buffers.get(path.basename(filePath)),
  };

  const media = await loadExportMedia(
    { uploadDir: path.join(__dirname, 'virtual-uploads') },
    photos,
    [],
    dependencies,
  );

  assert.equal(media.filter((item) => item.status === 'included').length, 5);
  assert.equal(media.filter((item) => item.status === 'missing-or-unreadable').length, 1);

  const aboveLimit = [...photos.slice(0, 5), ...photos.slice(0, 2).map(
    (photo, index) => ({
      ...photo,
      id: 10 + index,
      storage_name: photo.storage_name,
    }),
  )];
  await assert.rejects(
    loadExportMedia(
      { uploadDir: path.join(__dirname, 'virtual-uploads') },
      aboveLimit,
      [],
      dependencies,
    ),
    /(?:total export|inspection) limit/,
  );

  const corruptCandidate = Buffer.alloc(8 * 1024 * 1024);
  const corruptBuffers = new Map();
  const corruptPhotos = Array.from({ length: 17 }, (_, index) => {
    const storageName = `${String(index + 100).padStart(32, '0')}.jpg`;
    corruptBuffers.set(storageName, corruptCandidate);
    return {
      journal_entry_id: 2,
      id: index + 100,
      media_type: 'image/jpeg',
      storage_name: storageName,
      storage_type: 'upload',
    };
  });
  let corruptReads = 0;
  await assert.rejects(
    loadExportMedia(
      { uploadDir: path.join(__dirname, 'virtual-uploads') },
      corruptPhotos,
      [],
      {
        boundedRegularFile: async (filePath) => ({
          path: filePath,
          size: corruptBuffers.get(path.basename(filePath)).length,
        }),
        readFile: async (filePath) => {
          corruptReads += 1;
          return corruptBuffers.get(path.basename(filePath));
        },
      },
    ),
    /inspection limit/,
  );
  assert.equal(corruptReads, 16);
});

test('PDF output has a valid signature and relationship keepsake metadata', async () => {
  const data = sampleExportData();
  data.journals[0].photos[0] = {
    caption: 'At the water',
    date: '2025-07-04',
    file: 'Photos/at-the-water.webp',
    mediaType: 'image/webp',
    status: 'available',
  };
  const pdf = await buildPdf(data, [{
    archivePath: 'Photos/at-the-water.webp',
    buffer: Buffer.from('unused webp placeholder'),
    kind: 'journal-photo',
    mediaType: 'image/webp',
    record: {
      id: 6,
      journal_entry_id: 2,
      caption: 'At the water',
      media_type: 'image/webp',
    },
    status: 'included',
  }]);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  const text = pdf.toString('latin1');
  const prose = extractedPdfText(pdf);
  assert.match(text, /Our GBAGL Keepsake/);
  assert.match(text, /A keepsake of our shared story/);
  assert.match(prose, /Our GBAGL Keepsake/);
  assert.match(prose, /Dear Alex,/);
  assert.match(prose, /JULY 31, 2026 AT 7:00 PM/);
  assert.match(prose, /preserved in the printable keepsake/);
  assert.doesNotMatch(prose, /Photos\/|media\/|archive|000006|included in ZIP/i);
  assert.match(text, /\/Type \/Page/);
  assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 5);
});

test('empty sections and supported photos render as finished keepsake elements', async () => {
  const empty = sampleExportData();
  empty.timeline = [];
  empty.journals = [];
  empty.bucketMemories = [];
  empty.sharedEvents = [];
  const emptyHtml = buildPrintableHtml(empty);
  const emptyPdf = extractedPdfText(await buildPdf(empty, []));
  for (const message of [
    'Our next Timeline moment is still waiting to be added.',
    'The first Journal letter is still waiting to be written.',
    'Completed adventures will become memories here.',
    'There are no shared events in this keepsake yet.',
  ]) {
    assert.match(htmlProse(emptyHtml), new RegExp(message.replace(/[.]/g, '\\.')));
    assert.match(emptyPdf, new RegExp(message.replace(/[.]/g, '\\.')));
  }

  const data = sampleExportData();
  const png = PNG.sync.write({
    data: Buffer.alloc(120 * 60 * 4, 0xff),
    height: 60,
    width: 120,
  });
  data.timeline[0].photo = {
    file: 'Photos/first-trip.png',
    mediaType: 'image/png',
    status: 'available',
  };
  const media = [{
    archivePath: 'Photos/first-trip.png',
    buffer: png,
    kind: 'timeline',
    mediaType: 'image/png',
    record: { id: 1, title: 'First trip' },
    status: 'included',
  }];
  const html = buildPrintableHtml(data);
  const pdfProse = extractedPdfText(await buildPdf(data, media));
  assert.match(html, /<img src="Photos\/first-trip\.png" alt="First trip">/);
  assert.match(html, /<figcaption>First trip<\/figcaption>/);
  assert.match(pdfProse, /First trip/);
  assert.doesNotMatch(pdfProse, /Photos\/first-trip/);
});

test('long Journal entries paginate while keeping a clean chapter and footer hierarchy', async () => {
  const data = sampleExportData();
  data.journals[0].title = 'A very long letter';
  data.journals[0].body = [
    'Dear Alex,',
    ...Array.from(
      { length: 90 },
      (_, index) => `Memory ${index + 1}: ${'A day worth remembering together. '.repeat(5)}`,
    ),
    'Always,',
    'Jordan',
  ].join('\n\n');

  const pdf = await buildPdf(data, []);
  const raw = pdf.toString('latin1');
  const prose = extractedPdfText(pdf);
  const pageCount = (raw.match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pageCount > 6);
  assert.match(prose, /CHAPTER 02/);
  assert.match(prose, /A very long letter/);
  assert.match(prose, /Memory 90:/);
  assert.equal((prose.match(/OUR GBAGL KEEPSAKE/g) || []).length, pageCount - 1);
});

test('PDF photo layout respects portrait and landscape proportions', () => {
  const doc = {
    page: {
      margins: { left: 58, right: 58 },
      width: 612,
    },
  };
  const landscape = pdfImageLayout(doc, { pdfHeight: 600, pdfWidth: 1200 });
  const portrait = pdfImageLayout(doc, { pdfHeight: 1200, pdfWidth: 600 });
  assert.deepEqual(landscape, { height: 225, width: 450 });
  assert.deepEqual(portrait, { height: 370, width: 185 });
});

test('PDF image preparation fully decodes PNGs and rejects malformed image data', async () => {
  const valid = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'icons', 'icon-192.png'),
  );
  const normalized = await safePdfImage(valid, 'image/png');
  assert.deepEqual([...normalized.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const malformed = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(malformed);
  malformed.writeUInt32BE(13, 8);
  malformed.write('IHDR', 12, 'ascii');
  malformed.writeUInt32BE(1, 16);
  malformed.writeUInt32BE(1, 20);
  await assert.rejects(safePdfImage(malformed, 'image/png'));
});

test('PDF media preparation enforces aggregate pixel and image budgets', async () => {
  const compressed = PNG.sync.write({
    data: Buffer.alloc(16 * 16 * 4, 0xff),
    height: 16,
    width: 16,
  });
  const media = [1, 2, 3].map((id) => ({
    archivePath: `media/journal/000002/photo-${String(id).padStart(6, '0')}.png`,
    buffer: compressed,
    kind: 'journal-photo',
    mediaType: 'image/png',
    record: { journal_entry_id: 2, id, media_type: 'image/png' },
    status: 'included',
  }));

  const pixelLimited = await preparePdfMedia(media, {
    maxImages: 3,
    maxTotalPixels: 300,
  });
  assert.equal(pixelLimited[0].pdfStatus, 'included');
  assert.equal(pixelLimited[1].pdfStatus, 'skipped-total-pixel-budget');
  assert.equal(pixelLimited[2].pdfStatus, 'skipped-total-pixel-budget');

  const countLimited = await preparePdfMedia(media, {
    maxImages: 1,
    maxTotalPixels: 1024,
  });
  assert.equal(countLimited[0].pdfStatus, 'included');
  assert.equal(countLimited[1].pdfStatus, 'skipped-image-count-budget');
  assert.equal(countLimited[2].pdfStatus, 'skipped-image-count-budget');
});

test('PDF preparation reuses one safe image result for deduplicated photo references', async () => {
  const compressed = PNG.sync.write({
    data: Buffer.alloc(16 * 16 * 4, 0xff),
    height: 16,
    width: 16,
  });
  let preparationCalls = 0;
  const media = Array.from({ length: 3 }, (_, index) => ({
    archivePath: 'Photos/shared-memory.png',
    buffer: compressed,
    kind: index === 0 ? 'journal-photo' : 'timeline',
    mediaType: 'image/png',
    record: { id: index + 1, media_type: 'image/png' },
    status: 'included',
  }));
  const prepared = await preparePdfMedia(media, {
    maxImages: 1,
    prepareImage: async (buffer) => {
      preparationCalls += 1;
      return { buffer, height: 16, width: 16 };
    },
  });

  assert.equal(preparationCalls, 1);
  assert.deepEqual(prepared.map((item) => item.pdfStatus), [
    'included',
    'included',
    'included',
  ]);
  assert.equal(prepared[0].pdfBuffer, prepared[2].pdfBuffer);
});

test('PDF decoded-byte budget skips excess large PNGs before preparation', async () => {
  const compressedFixture = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(compressedFixture);
  compressedFixture.writeUInt32BE(13, 8);
  compressedFixture.write('IHDR', 12, 'ascii');
  compressedFixture.writeUInt32BE(3500, 16);
  compressedFixture.writeUInt32BE(3000, 20);
  const media = Array.from({ length: 4 }, (_, index) => ({
    archivePath: `media/journal/000002/photo-${String(index + 1).padStart(6, '0')}.png`,
    buffer: compressedFixture,
    kind: 'journal-photo',
    mediaType: 'image/png',
    record: {
      journal_entry_id: 2,
      caption: `Large PNG ${index + 1}`,
      id: index + 1,
      media_type: 'image/png',
    },
    status: 'included',
  }));
  let preparationCalls = 0;
  const limits = {
    prepareImage: async (buffer) => {
      preparationCalls += 1;
      return {
        buffer,
        decodedBytes: 3500 * 3000 * 4,
        height: 3000,
        width: 3500,
      };
    },
  };

  const prepared = await preparePdfMedia(media, limits);

  assert.equal(preparationCalls, 2);
  assert.deepEqual(
    prepared.map((item) => item.pdfStatus),
    [
      'included',
      'included',
      'skipped-decoded-byte-budget',
      'skipped-decoded-byte-budget',
    ],
  );

  preparationCalls = 0;
  const pdf = await buildPdf(sampleExportData(), media, limits);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(preparationCalls, 2);
  assert.ok(pdf.length < 160 * 1024 * 1024);
});

test('PDF item planning moves image blocks that do not fit the printable area', () => {
  let addedPages = 0;
  const doc = {
    page: {
      height: 792,
      margins: {
        bottom: 58,
        left: 54,
        right: 54,
        top: 54,
      },
    },
    y: 500,
    addPage() {
      addedPages += 1;
      this.y = 54;
    },
    font() { return this; },
    fontSize() { return this; },
    heightOfString(value) { return value.length; },
  };

  reservePdfItem(doc, [
    { font: 'Helvetica-Bold', size: 11, text: 'Measured heading' },
    { font: 'Helvetica', size: 10, text: 'Measured description' },
  ], 300);

  assert.equal(addedPages, 1);
  assert.equal(doc.y, 54);
  assert.ok(doc.y + 300 <= doc.page.height - doc.page.margins.bottom);
});

test('PDF continues when a header-valid JPEG is rejected by PDFKit embedding', async () => {
  const craftedJpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xff, 0xc0,
    0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  assert.equal(await safePdfImage(craftedJpeg, 'image/jpeg'), craftedJpeg);

  const notes = [];
  const fakeDoc = {
    font() { return this; },
    fontSize() { return this; },
    fillColor() { return this; },
    image() { throw new Error('Unknown JPEG marker'); },
    text(value) { notes.push(value); return this; },
  };
  assert.equal(embedPdfImage(
    fakeDoc,
    craftedJpeg,
    { fit: [450, 300] },
    'Photo could not be embedded; its caption remains in this PDF.',
  ), false);
  assert.deepEqual(notes, [
    'Photo could not be embedded; its caption remains in this PDF.',
  ]);

  const data = sampleExportData();
  data.journals[0].photos[0] = {
    caption: 'Crafted JPEG',
    file: 'Photos/crafted-jpeg.jpg',
    mediaType: 'image/jpeg',
    status: 'available',
  };
  const pdf = await buildPdf(data, [{
    archivePath: 'Photos/crafted-jpeg.jpg',
    buffer: craftedJpeg,
    kind: 'journal-photo',
    mediaType: 'image/jpeg',
    record: {
      journal_entry_id: 2,
      caption: 'Crafted JPEG',
      id: 6,
      media_type: 'image/jpeg',
    },
    status: 'included',
  }]);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.match(extractedPdfText(pdf), /could not be displayed, but its caption remains/);
});

test('download responses use private headers and friendly dated filenames', async (t) => {
  assert.match(exportFilename('pdf'), /^our-gbagl-keepsake-\d{4}-\d{2}-\d{2}\.pdf$/);
  const app = express();
  app.use('/exports', createExportRouter({
    createPdf: async () => Buffer.from('%PDF-test'),
    createZip: async () => Buffer.from('PK-test'),
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/exports`;

  for (const [extension, mediaType] of [
    ['pdf', 'application/pdf'],
    ['zip', 'application/zip'],
  ]) {
    const response = await fetch(`${base}/keepsake.${extension}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mediaType);
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(
      response.headers.get('content-disposition'),
      new RegExp(`attachment; filename="our-gbagl-keepsake-\\d{4}-\\d{2}-\\d{2}\\.${extension}"`),
    );
  }
});

test('export data uses one repeatable-read transaction and always releases it', async () => {
  const calls = [];
  const connection = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes('site_settings')) return [[
        { setting_key: 'timezone', setting_value: 'UTC' },
      ]];
      return [[]];
    },
    commit: async () => calls.push('COMMIT'),
    rollback: async () => calls.push('ROLLBACK'),
    release: () => calls.push('RELEASE'),
  };
  const data = await loadKeepsakeData({
    isDbAvailable: () => true,
    getPool: () => ({ getConnection: async () => connection }),
  });
  assert.equal(data.settings.timezone, 'UTC');
  assert.equal(calls[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  assert.equal(calls[1], 'START TRANSACTION WITH CONSISTENT SNAPSHOT');
  assert.equal(calls.at(-2), 'COMMIT');
  assert.equal(calls.at(-1), 'RELEASE');
  assert.equal(calls.includes('ROLLBACK'), false);
});

test('export data rolls back and releases when a snapshot query fails', async () => {
  const calls = [];
  const connection = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes('journal_entries')) throw new Error('query failed');
      return [[]];
    },
    commit: async () => calls.push('COMMIT'),
    rollback: async () => calls.push('ROLLBACK'),
    release: () => calls.push('RELEASE'),
  };
  await assert.rejects(
    loadKeepsakeData({
      isDbAvailable: () => true,
      getPool: () => ({ getConnection: async () => connection }),
    }),
    /query failed/,
  );
  assert.equal(calls.at(-2), 'ROLLBACK');
  assert.equal(calls.at(-1), 'RELEASE');
  assert.equal(calls.includes('COMMIT'), false);
});
