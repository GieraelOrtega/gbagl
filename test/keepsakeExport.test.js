const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const {
  buildPdf,
  buildPrintableHtml,
  buildZip,
  embedPdfImage,
  ensurePdfSpace,
  loadKeepsakeData,
  mediaArchiveName,
  preparePdfMedia,
  reservePdfItem,
  safeArchiveName,
  safePdfImage,
} = require('../services/keepsakeExport');

function sampleExportData() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-20T05:00:00.000Z',
    settings: {
      partner_one_name: 'Alex',
      partner_two_name: 'Jordan',
      anniversary_date: '2020-02-29',
      timezone: 'America/Los_Angeles',
    },
    timeline: [{
      id: 1,
      display_order: 0,
      milestone_date: 'Spring 2020',
      title: 'First trip',
      description: 'A memorable beginning',
      emoji: '',
      archive_path: null,
      media_status: null,
      media_type: null,
    }],
    journals: [{
      id: 2,
      milestone_id: 1,
      title: 'Looking back',
      body: 'Still smiling.',
      entry_date: '2026-01-02',
    }],
    completedBucketItems: [{
      id: 3,
      title: 'See the coast',
      description: 'Drive west',
      category: 'travel',
      target_date: '2025-06-01',
      completed_at: '2025-07-04',
      memory: 'Sunset together',
    }],
    events: [{
      id: 4,
      title: 'Dinner',
      event_at: '2026-08-01T02:00:00Z',
      reminder_at: '2026-08-01T01:00:00Z',
      notes: 'Window table',
      is_completed: 0,
    }],
    albums: [{
      id: 5,
      title: 'Summer',
      description: 'Warm days',
      album_date: '2025-07-04',
      display_order: 0,
    }],
    photos: [{
      id: 6,
      album_id: 5,
      milestone_id: 1,
      caption: 'At the water',
      photo_date: '2025-07-04',
      display_order: 0,
      media_type: 'image/webp',
      archive_path: 'media/albums/000005/photo-000006.webp',
      media_status: 'missing-or-unreadable',
    }],
  };
}

test('generated ZIP entry names are deterministic and reject zip-slip input', () => {
  assert.equal(
    mediaArchiveName({ id: 6, album_id: 5, media_type: 'image/png' }),
    'media/albums/000005/photo-000006.png',
  );
  assert.equal(safeArchiveName('media/albums/000005/photo-000006.png'), 'media/albums/000005/photo-000006.png');
  for (const invalid of ['../secret', '/absolute', 'media\\photo.jpg', 'media//photo.jpg']) {
    assert.throws(() => safeArchiveName(invalid), /Invalid generated archive/);
  }
});

test('printable HTML and ZIP contain portable keepsake content without server paths', async () => {
  const data = sampleExportData();
  const html = buildPrintableHtml(data);
  assert.match(html, /Alex &amp; Jordan/);
  assert.match(html, /Sunset together/);
  assert.match(html, /media\/albums\/000005\/photo-000006\.webp/);
  assert.doesNotMatch(html, /runtime[\\/]uploads|storage_name|DB_PASSWORD/);

  const zip = await buildZip(data, [{
    archivePath: data.photos[0].archive_path,
    buffer: null,
    kind: 'album',
    record: { id: 6 },
    status: 'missing-or-unreadable',
  }]);
  assert.equal(zip.subarray(0, 2).toString('ascii'), 'PK');
  const archiveText = zip.toString('latin1');
  assert.match(archiveText, /keepsake\.html/);
  assert.match(archiveText, /data\.json/);
  assert.match(archiveText, /manifest\.json/);
  assert.doesNotMatch(archiveText, /\.\.\/|runtime[\\/]uploads/);
});

test('PDF output has a valid signature and relationship keepsake metadata', async () => {
  const pdf = await buildPdf(sampleExportData(), [{
    archivePath: 'media/albums/000005/photo-000006.webp',
    buffer: Buffer.from('unused webp placeholder'),
    kind: 'album',
    mediaType: 'image/webp',
    record: { id: 6, album_id: 5, caption: 'At the water', media_type: 'image/webp' },
    status: 'included',
  }]);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  const text = pdf.toString('latin1');
  assert.match(text, /GBAGL Relationship Keepsake/);
  assert.match(text, /Timeline, journal, memories, events, and albums/);
  assert.match(text, /\/Type \/Page/);
  assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 1);
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
    archivePath: `media/albums/000005/photo-${String(id).padStart(6, '0')}.png`,
    buffer: compressed,
    kind: 'album',
    mediaType: 'image/png',
    record: { album_id: 5, id, media_type: 'image/png' },
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

  const pdf = await buildPdf(sampleExportData(), [{
    archivePath: 'media/albums/000005/photo-000006.jpg',
    buffer: craftedJpeg,
    kind: 'album',
    mediaType: 'image/jpeg',
    record: {
      album_id: 5,
      caption: 'Crafted JPEG',
      id: 6,
      media_type: 'image/jpeg',
    },
    status: 'included',
  }]);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
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
