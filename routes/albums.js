const express = require('express');
const fs = require('fs');
const path = require('path');
const { getPool, isDbAvailable } = require('../db');
const {
  nextDisplayOrder,
  publicOrderError,
  reorderCollection,
} = require('../lib/contentOrder');
const {
  existingImageName,
  validateAlbum,
  validatePhoto,
} = require('../lib/hubValidation');
const {
  inspectAndStoreUpload,
  inspectExistingImage,
  removeUpload,
  safeUploadPath,
} = require('../lib/media');
const { positiveId } = require('../lib/validation');
const { MEDIA_OPT_IN, PRIVATE_SNAPSHOT_HEADER } = require('../public/js/pwaPolicy');
const { withMediaOperation } = require('../services/mediaCoordinator');

function unavailable(res, message) {
  return res.status(503).render('error', {
    title: 'Albums unavailable | GBAGL',
    page: 'albums',
    status: 503,
    message,
  });
}

function redirectAlbums(res, type, message) {
  return res.redirect(303, `/albums?${new URLSearchParams({ [type]: message })}`);
}

function redirectAlbum(res, albumId, type, message) {
  let destination = '/albums';
  try {
    destination = `/albums/${positiveId(String(albumId))}`;
  } catch {
    // A failed create may not have a usable album ID yet.
  }
  return res.redirect(303, `${destination}?${new URLSearchParams({ [type]: message })}`);
}

async function milestoneOptions() {
  const [rows] = await getPool().execute(
    'SELECT id, title FROM timeline_milestones ORDER BY display_order, id',
  );
  return rows;
}

async function updatePhotoDetails(databasePool, idValue, photo) {
  const id = positiveId(String(idValue));
  const destinationAlbumId = positiveId(String(photo.albumId));
  const connection = await databasePool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.execute(
      'SELECT album_id, display_order FROM album_photos WHERE id = ? FOR UPDATE',
      [id],
    );
    if (!rows[0]) throw new Error('Photo not found');
    const sourceAlbumId = Number(rows[0].album_id);
    const sourceDisplayOrder = Number(rows[0].display_order);
    const moved = sourceAlbumId !== destinationAlbumId;
    let destinationDisplayOrder = sourceDisplayOrder;

    if (moved) {
      const albumIds = [sourceAlbumId, destinationAlbumId].sort((left, right) => left - right);
      const [albums] = await connection.execute(
        `SELECT id FROM photo_albums
         WHERE id IN (?, ?) ORDER BY id FOR UPDATE`,
        albumIds,
      );
      if (!albums.some((album) => Number(album.id) === destinationAlbumId)) {
        throw new Error('Album not found');
      }
      const [lastPhotos] = await connection.execute(
        `SELECT display_order FROM album_photos
         WHERE album_id = ?
         ORDER BY display_order DESC, id DESC LIMIT 1 FOR UPDATE`,
        [destinationAlbumId],
      );
      destinationDisplayOrder = Number(lastPhotos[0]?.display_order ?? -1) + 1;
      if (!Number.isSafeInteger(destinationDisplayOrder) || destinationDisplayOrder < 0) {
        throw new Error('Could not determine the destination photo order');
      }
    }

    await connection.execute(
      `UPDATE album_photos
       SET album_id = ?, milestone_id = ?, caption = ?, photo_date = ?, display_order = ?
       WHERE id = ?`,
      [
        destinationAlbumId,
        photo.milestoneId,
        photo.caption || null,
        photo.photoDate,
        destinationDisplayOrder,
        id,
      ],
    );
    await connection.commit();
    transactionStarted = false;
    return { albumId: destinationAlbumId, moved };
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Photo update rollback failed:', rollbackError.message);
      }
    }
    throw error;
  } finally {
    connection.release();
  }
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
                  a.display_order, COUNT(p.id) AS photo_count,
                  (
                    SELECT cover.id FROM album_photos cover
                    WHERE cover.album_id = a.id
                    ORDER BY cover.display_order, cover.id
                    LIMIT 1
                  ) AS cover_photo_id
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
    if (!dbError) res.allowPrivateSnapshot?.();
    return res.render('albums', {
      title: 'Photo Albums | GBAGL',
      page: 'albums',
      albums,
      dbError,
      message: req.query.message || null,
      error: req.query.error || null,
    });
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
        [PRIVATE_SNAPSHOT_HEADER]: MEDIA_OPT_IN,
        'X-Content-Type-Options': 'nosniff',
      });
      return res.sendFile(filePath);
    } catch (error) {
      console.error('Protected photo load failed:', error.message);
      return next();
    }
  });

  router.get('/:id', async (req, res, next) => {
    if (!isDbAvailable()) return unavailable(res, 'The database is unavailable.');
    try {
      const id = positiveId(req.params.id);
      const [[albums], [photos], [albumOptions], milestones] = await Promise.all([
        getPool().execute(
          `SELECT id, title, description,
                  DATE_FORMAT(album_date, '%Y-%m-%d') AS album_date,
                  display_order
           FROM photo_albums WHERE id = ?`,
          [id],
        ),
        getPool().execute(
          `SELECT p.id, p.album_id, p.caption,
                  DATE_FORMAT(p.photo_date, '%Y-%m-%d') AS photo_date,
                  p.display_order, p.milestone_id, m.title AS milestone_title
           FROM album_photos p
           LEFT JOIN timeline_milestones m ON m.id = p.milestone_id
           WHERE p.album_id = ? ORDER BY p.display_order, p.id`,
          [id],
        ),
        getPool().execute(
          'SELECT id, title FROM photo_albums ORDER BY display_order, id',
        ),
        milestoneOptions(),
      ]);
      if (!albums[0]) return next();
      res.allowPrivateSnapshot?.();
      return res.render('album', {
        title: `${albums[0].title} | GBAGL`,
        page: 'albums',
        album: albums[0],
        albums: albumOptions,
        photos,
        milestones,
        message: req.query.message || null,
        error: req.query.error || null,
      });
    } catch (error) {
      if (/record ID/.test(error.message)) return next();
      console.error('Album load failed:', error.message);
      return unavailable(res, 'The album could not be loaded.');
    }
  });

  router.post('/', async (req, res) => {
    if (!isDbAvailable()) return redirectAlbums(res, 'error', 'Database unavailable.');
    try {
      const album = validateAlbum(req.body);
      const displayOrder = await nextDisplayOrder(getPool(), 'albums');
      const [result] = await getPool().execute(
        `INSERT INTO photo_albums (title, description, album_date, display_order)
         VALUES (?, ?, ?, ?)`,
        [album.title, album.description, album.albumDate, displayOrder],
      );
      return redirectAlbum(res, result.insertId, 'message', 'Album added.');
    } catch (error) {
      console.error('Album create failed:', error.message);
      return redirectAlbums(res, 'error', error.message);
    }
  });

  router.post('/reorder', async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'Database unavailable' });
    try {
      await reorderCollection(getPool(), 'albums', req.body.ids);
      return res.status(204).end();
    } catch (error) {
      console.error('Album reorder failed:', error.message);
      const publicError = publicOrderError(error);
      return res.status(publicError.status).json({ error: publicError.message });
    }
  });

  router.post('/:id/photos/reorder', async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'Database unavailable' });
    try {
      const albumId = positiveId(req.params.id);
      await reorderCollection(getPool(), 'photos', req.body.ids, albumId);
      return res.status(204).end();
    } catch (error) {
      console.error('Photo reorder failed:', error.message);
      const publicError = publicOrderError(error);
      return res.status(publicError.status).json({ error: publicError.message });
    }
  });

  router.post('/photos/upload', async (req, res) => {
    if (!isDbAvailable()) return redirectAlbums(res, 'error', 'Database unavailable.');
    return withMediaOperation(async () => {
      let stored = null;
      try {
        const photo = validatePhoto(req.body);
        stored = await inspectAndStoreUpload(req.file, config.uploadDir);
        const displayOrder = await nextDisplayOrder(
          getPool(),
          'photos',
          photo.albumId,
        );
        const [result] = await getPool().execute(
          `INSERT INTO album_photos
            (album_id, milestone_id, caption, photo_date, display_order,
             storage_type, storage_name, media_type)
           VALUES (?, ?, ?, ?, ?, 'upload', ?, ?)`,
          [
            photo.albumId,
            photo.milestoneId,
            photo.caption || null,
            photo.photoDate,
            displayOrder,
            stored.storageName,
            stored.mediaType,
          ],
        );
        if (result.affectedRows !== 1) throw new Error('Photo was not saved');
        return redirectAlbum(res, photo.albumId, 'message', 'Photo uploaded.');
      } catch (error) {
        if (stored) {
          await removeUpload(config.uploadDir, stored.storageName).catch((cleanupError) => {
            console.error('Rejected stored upload cleanup failed:', cleanupError.message);
          });
        } else if (req.file?.path) {
          await fs.promises.rm(req.file.path, { force: true }).catch((cleanupError) => {
            console.error('Rejected temporary upload cleanup failed:', cleanupError.message);
          });
        }
        console.error('Photo upload failed:', error.message);
        return redirectAlbum(res, req.body.album_id, 'error', error.message);
      }
    });
  });

  router.post('/photos/existing', async (req, res) => {
    if (!isDbAvailable()) return redirectAlbums(res, 'error', 'Database unavailable.');
    try {
      const photo = validatePhoto(req.body);
      const storageName = existingImageName(req.body.existing_image);
      const imagePath = path.resolve(__dirname, '..', 'public', 'images', storageName);
      const expectedRoot = path.resolve(__dirname, '..', 'public', 'images');
      if (path.dirname(imagePath) !== expectedRoot) throw new Error('Invalid existing image path');
      const mediaType = await inspectExistingImage(imagePath);
      const displayOrder = await nextDisplayOrder(getPool(), 'photos', photo.albumId);
      await getPool().execute(
        `INSERT INTO album_photos
          (album_id, milestone_id, caption, photo_date, display_order,
           storage_type, storage_name, media_type)
         VALUES (?, ?, ?, ?, ?, 'existing', ?, ?)`,
        [
          photo.albumId,
          photo.milestoneId,
          photo.caption || null,
          photo.photoDate,
          displayOrder,
          storageName,
          mediaType,
        ],
      );
      return redirectAlbum(res, photo.albumId, 'message', 'Existing photo linked.');
    } catch (error) {
      console.error('Existing photo link failed:', error.message);
      return redirectAlbum(res, req.body.album_id, 'error', error.message);
    }
  });

  router.post('/photos/:id', async (req, res) => {
    if (!isDbAvailable()) return redirectAlbums(res, 'error', 'Database unavailable.');
    try {
      const photo = validatePhoto(req.body);
      await updatePhotoDetails(getPool(), req.params.id, photo);
      return redirectAlbum(res, photo.albumId, 'message', 'Photo details updated.');
    } catch (error) {
      console.error('Photo update failed:', error.message);
      return redirectAlbum(res, req.body.album_id, 'error', error.message);
    }
  });

  router.post('/photos/:id/delete', async (req, res) => {
    if (!isDbAvailable()) return redirectAlbums(res, 'error', 'Database unavailable.');
    return withMediaOperation(async () => {
      try {
        const id = positiveId(req.params.id);
        const [rows] = await getPool().execute(
          `SELECT album_id, storage_type, storage_name
           FROM album_photos WHERE id = ?`,
          [id],
        );
        if (!rows[0]) throw new Error('Photo not found');
        await getPool().execute('DELETE FROM album_photos WHERE id = ?', [id]);
        if (rows[0].storage_type === 'upload') {
          try {
            await removeUpload(config.uploadDir, rows[0].storage_name);
          } catch (cleanupError) {
            console.error('Deleted photo media cleanup failed:', cleanupError.message);
            return redirectAlbum(
              res,
              rows[0].album_id,
              'error',
              'Photo record deleted, but the orphaned upload file requires cleanup.',
            );
          }
        }
        return redirectAlbum(res, rows[0].album_id, 'message', 'Photo deleted.');
      } catch (error) {
        console.error('Photo delete failed:', error.message);
        return redirectAlbum(res, req.body.album_id, 'error', error.message);
      }
    });
  });

  router.post('/:id', async (req, res) => {
    if (!isDbAvailable()) return redirectAlbums(res, 'error', 'Database unavailable.');
    try {
      const id = positiveId(req.params.id);
      const album = validateAlbum(req.body);
      const [result] = await getPool().execute(
        `UPDATE photo_albums
         SET title = ?, description = ?, album_date = ?
         WHERE id = ?`,
        [album.title, album.description, album.albumDate, id],
      );
      if (result.affectedRows !== 1) throw new Error('Album not found');
      return redirectAlbum(res, id, 'message', 'Album updated.');
    } catch (error) {
      console.error('Album update failed:', error.message);
      return redirectAlbums(res, 'error', error.message);
    }
  });

  router.post('/:id/delete', async (req, res) => {
    if (!isDbAvailable()) return redirectAlbums(res, 'error', 'Database unavailable.');
    return withMediaOperation(async () => {
      let connection = null;
      let transactionStarted = false;
      let uploads = [];
      try {
        connection = await getPool().getConnection();
        const id = positiveId(req.params.id);
        await connection.beginTransaction();
        transactionStarted = true;
        const [albums] = await connection.execute(
          'SELECT id FROM photo_albums WHERE id = ? FOR UPDATE',
          [id],
        );
        if (!albums[0]) throw new Error('Album not found');
        [uploads] = await connection.execute(
          `SELECT storage_name FROM album_photos
           WHERE album_id = ? AND storage_type = 'upload' FOR UPDATE`,
          [id],
        );
        await connection.execute('DELETE FROM photo_albums WHERE id = ?', [id]);
        await connection.commit();
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) {
          try {
            await connection.rollback();
          } catch (rollbackError) {
            console.error('Album delete rollback failed:', rollbackError.message);
          }
        }
        console.error('Album delete failed:', error.message);
        return redirectAlbums(res, 'error', error.message);
      } finally {
        if (connection) connection.release();
      }
      const cleanup = await Promise.allSettled(
        uploads.map((photo) => removeUpload(config.uploadDir, photo.storage_name)),
      );
      const failed = cleanup.filter((result) => result.status === 'rejected');
      if (!failed.length) return redirectAlbums(res, 'message', 'Album deleted.');
      failed.forEach((result) => console.error(
        'Deleted album media cleanup failed:',
        result.reason.message,
      ));
      return redirectAlbums(
        res,
        'error',
        'Album deleted, but one or more orphaned upload files require cleanup.',
      );
    });
  });

  return router;
}

module.exports = { createAlbumsRouter, updatePhotoDetails };
