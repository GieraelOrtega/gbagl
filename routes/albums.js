const express = require('express');
const fs = require('fs');
const path = require('path');
const { getPool, isDbAvailable } = require('../db');
const { existingImageName } = require('../lib/hubValidation');
const { safeUploadPath } = require('../lib/media');
const { positiveId } = require('../lib/validation');
const { MEDIA_OPT_IN, PRIVATE_SNAPSHOT_HEADER } = require('../public/js/pwaPolicy');

function journalRedirect(res, message = null, anchor = '') {
  const query = message
    ? `?${new URLSearchParams({ message })}`
    : '';
  return res.redirect(303, `/journal${query}${anchor}`);
}

function createAlbumsRouter(config) {
  const router = express.Router();

  router.get('/photos/:id/content', async (req, res, next) => {
    if (!isDbAvailable()) return res.status(503).end();
    try {
      const [rows] = await getPool().execute(
        'SELECT storage_type, storage_name, media_type FROM album_photos WHERE id = ?',
        [positiveId(req.params.id)],
      );
      if (!rows[0]) return next();
      const photo = rows[0];
      const filePath = photo.storage_type === 'upload'
        ? safeUploadPath(config.uploadDir, photo.storage_name)
        : path.resolve(
          __dirname,
          '..',
          'public',
          'images',
          existingImageName(photo.storage_name),
        );
      const expectedRoot = photo.storage_type === 'upload'
        ? path.resolve(config.uploadDir)
        : path.resolve(__dirname, '..', 'public', 'images');
      if (path.dirname(filePath) !== expectedRoot) throw new Error('Invalid photo path');
      await fs.promises.access(filePath, fs.constants.R_OK);
      res.set({
        'Content-Type': photo.media_type,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        [PRIVATE_SNAPSHOT_HEADER]: MEDIA_OPT_IN,
        'X-Content-Type-Options': 'nosniff',
      });
      return res.sendFile(filePath);
    } catch (error) {
      console.error('Protected photo load failed:', error.message);
      return next();
    }
  });

  router.get('/', (req, res) => journalRedirect(res));

  router.get('/:id', async (req, res) => {
    if (!isDbAvailable()) return journalRedirect(res);
    try {
      const [rows] = await getPool().execute(
        'SELECT id FROM journal_entries WHERE source_album_id = ?',
        [positiveId(req.params.id)],
      );
      const anchor = rows[0] ? `#journal-entry-${rows[0].id}` : '';
      return journalRedirect(res, null, anchor);
    } catch {
      return journalRedirect(res);
    }
  });

  router.use((req, res) => journalRedirect(
    res,
    'Albums are now managed as moments in the Journal.',
  ));

  return router;
}

module.exports = { createAlbumsRouter };
