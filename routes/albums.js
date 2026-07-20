const express = require('express');
const fs = require('fs');
const path = require('path');
const { getPool, isDbAvailable } = require('../db');
const { safeUploadPath } = require('../lib/media');
const { existingImageName } = require('../lib/hubValidation');
const { positiveId } = require('../lib/validation');

function unavailable(res, message) {
  return res.status(503).render('error', {
    title: 'Albums unavailable | GBAGL',
    page: 'albums',
    status: 503,
    message,
  });
}

function createAlbumsRouter(config) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    let albums = [];
    let dbError = null;
    if (!isDbAvailable()) {
      dbError = 'Albums are temporarily unavailable because the database is offline.';
    } else {
      try {
        [albums] = await getPool().execute(
          `SELECT a.id, a.title, a.description,
                  DATE_FORMAT(a.album_date, '%Y-%m-%d') AS album_date,
                  COUNT(p.id) AS photo_count, MIN(p.id) AS cover_photo_id
           FROM photo_albums a
           LEFT JOIN album_photos p ON p.album_id = a.id
           GROUP BY a.id
           ORDER BY a.display_order, a.album_date IS NULL, a.album_date DESC, a.id`,
        );
      } catch (error) {
        console.error('Album list load failed:', error.message);
        dbError = 'Albums could not be loaded.';
      }
    }
    return res.render('albums', {
      title: 'Photo Albums | GBAGL',
      page: 'albums',
      albums,
      dbError,
    });
  });

  router.get('/:id', async (req, res, next) => {
    if (!isDbAvailable()) return unavailable(res, 'The database is unavailable.');
    try {
      const id = positiveId(req.params.id);
      const [[albums], [photos]] = await Promise.all([
        getPool().execute(
          `SELECT id, title, description,
                  DATE_FORMAT(album_date, '%Y-%m-%d') AS album_date
           FROM photo_albums WHERE id = ?`,
          [id],
        ),
        getPool().execute(
          `SELECT p.id, p.caption,
                  DATE_FORMAT(p.photo_date, '%Y-%m-%d') AS photo_date,
                  p.milestone_id, m.title AS milestone_title
           FROM album_photos p
           LEFT JOIN timeline_milestones m ON m.id = p.milestone_id
           WHERE p.album_id = ? ORDER BY p.display_order, p.id`,
          [id],
        ),
      ]);
      if (!albums[0]) return next();
      return res.render('album', {
        title: `${albums[0].title} | GBAGL`,
        page: 'albums',
        album: albums[0],
        photos,
      });
    } catch (error) {
      if (/record ID/.test(error.message)) return next();
      console.error('Album load failed:', error.message);
      return unavailable(res, 'The album could not be loaded.');
    }
  });

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
        'X-Content-Type-Options': 'nosniff',
      });
      return res.sendFile(filePath);
    } catch (error) {
      console.error('Protected photo load failed:', error.message);
      return next();
    }
  });

  return router;
}

module.exports = { createAlbumsRouter };
