const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { getPool, isDbAvailable } = require('../db');
const { pathContains } = require('../config');
const { mysqlUtc, zonedLocalToUtc } = require('../lib/dates');
const {
  existingImageName,
  validateAlbum,
  validateBucketItem,
  validateEvent,
  validateJournal,
  validatePhoto,
} = require('../lib/hubValidation');
const {
  inspectAndStoreUpload,
  inspectExistingImage,
  removeUpload,
} = require('../lib/media');
const { localInputValue } = require('../lib/presentation');
const { positiveId } = require('../lib/validation');
const { withMediaOperation } = require('../services/mediaCoordinator');

function redirectSettings(res, section, type, message) {
  const query = new URLSearchParams({ [type]: message });
  return res.redirect(303, `/settings/content/${section}?${query}`);
}

function requireDatabase(res, section) {
  if (isDbAvailable()) return false;
  redirectSettings(res, section, 'error', 'Database unavailable.');
  return true;
}

function createUploadIngress(config, accountAuth, passcodeAuth) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const publicDir = path.resolve(__dirname, '..', 'public');
  if (
    fs.existsSync(publicDir)
    && pathContains(fs.realpathSync(publicDir), fs.realpathSync(config.uploadDir))
  ) {
    throw new Error('UPLOAD_DIR resolves inside public/');
  }
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, callback) => callback(
        null,
        `${require('crypto').randomBytes(16).toString('hex')}.upload`,
      ),
    }),
    limits: { fileSize: config.uploadMaxBytes, files: 1, fields: 20 },
    fileFilter: (req, file, callback) => {
      callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
    },
  }).single('photo');

  return [
    passcodeAuth.requirePasscode,
    accountAuth.requireMember,
    (req, res, next) => {
      upload(req, res, (error) => {
        if (error) {
          console.error('Photo upload parsing failed:', error.message);
          return redirectSettings(
            res,
            'albums',
            'error',
            error.code === 'LIMIT_FILE_SIZE'
              ? `Photo exceeds the ${Math.floor(config.uploadMaxBytes / 1048576)} MB limit.`
              : 'Photo upload could not be read.',
          );
        }
        if (req.file?.path) {
          res.on('finish', () => fs.promises.rm(req.file.path, { force: true }).catch(
            (cleanupError) => console.error('Temporary upload cleanup failed:', cleanupError.message),
          ));
        }
        return next();
      });
    },
  ];
}

async function settingsTimezone() {
  const [rows] = await getPool().execute(
    "SELECT setting_value FROM site_settings WHERE setting_key = 'timezone'",
  );
  return rows[0]?.setting_value || 'UTC';
}

async function milestoneOptions() {
  const [rows] = await getPool().execute(
    'SELECT id, title FROM timeline_milestones ORDER BY display_order, id',
  );
  return rows;
}

function createSettingsContentRouter(config) {
  const router = express.Router();

  router.get('/bucket', async (req, res) => {
    let items = [];
    let dbError = null;
    if (isDbAvailable()) {
      try {
        [items] = await getPool().execute(
          `SELECT id, title, description, category,
                  DATE_FORMAT(target_date, '%Y-%m-%d') AS target_date
           FROM bucket_items ORDER BY id DESC`,
        );
      } catch (error) {
        console.error('Admin bucket load failed:', error.message);
        dbError = 'Bucket items could not be loaded.';
      }
    } else dbError = 'The database is unavailable.';
    return res.render('settings-bucket', {
      title: 'Manage Bucket List | GBAGL',
      page: 'settings',
      items,
      dbError,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  router.post('/bucket', async (req, res) => {
    if (requireDatabase(res, 'bucket')) return;
    try {
      const item = validateBucketItem(req.body);
      await getPool().execute(
        `INSERT INTO bucket_items (title, description, category, target_date)
         VALUES (?, ?, ?, ?)`,
        [item.title, item.description, item.category, item.targetDate],
      );
      return redirectSettings(res, 'bucket', 'message', 'Bucket item added.');
    } catch (error) {
      console.error('Admin bucket create failed:', error.message);
      return redirectSettings(res, 'bucket', 'error', error.message);
    }
  });

  router.post('/bucket/:id', async (req, res) => {
    if (requireDatabase(res, 'bucket')) return;
    try {
      const item = validateBucketItem(req.body);
      const [result] = await getPool().execute(
        `UPDATE bucket_items
         SET title = ?, description = ?, category = ?, target_date = ?
         WHERE id = ?`,
        [
          item.title,
          item.description,
          item.category,
          item.targetDate,
          positiveId(req.params.id),
        ],
      );
      if (result.affectedRows !== 1) throw new Error('Bucket item not found');
      return redirectSettings(res, 'bucket', 'message', 'Bucket item updated.');
    } catch (error) {
      console.error('Admin bucket update failed:', error.message);
      return redirectSettings(res, 'bucket', 'error', error.message);
    }
  });

  router.post('/bucket/:id/delete', async (req, res) => {
    if (requireDatabase(res, 'bucket')) return;
    try {
      const [result] = await getPool().execute(
        'DELETE FROM bucket_items WHERE id = ?',
        [positiveId(req.params.id)],
      );
      if (result.affectedRows !== 1) throw new Error('Bucket item not found');
      return redirectSettings(res, 'bucket', 'message', 'Bucket item deleted.');
    } catch (error) {
      console.error('Admin bucket delete failed:', error.message);
      return redirectSettings(res, 'bucket', 'error', error.message);
    }
  });

  router.get('/events', async (req, res) => {
    let events = [];
    let timeZone = 'UTC';
    let dbError = null;
    if (isDbAvailable()) {
      try {
        const [[rows], zone] = await Promise.all([
          getPool().execute(
            `SELECT id, title,
                    DATE_FORMAT(event_at, '%Y-%m-%dT%H:%i:%sZ') AS event_at,
                    DATE_FORMAT(reminder_at, '%Y-%m-%dT%H:%i:%sZ') AS reminder_at,
                    notes, is_completed
             FROM shared_events ORDER BY event_at DESC`,
          ),
          settingsTimezone(),
        ]);
        timeZone = zone;
        events = rows.map((event) => ({
          ...event,
          event_input: localInputValue(event.event_at, timeZone),
          reminder_input: localInputValue(event.reminder_at, timeZone),
        }));
      } catch (error) {
        console.error('Admin events load failed:', error.message);
        dbError = 'Events could not be loaded.';
      }
    } else dbError = 'The database is unavailable.';
    return res.render('settings-events', {
      title: 'Manage Events | GBAGL',
      page: 'settings',
      events,
      timeZone,
      dbError,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  async function eventValues(body) {
    const event = validateEvent(body);
    const timeZone = await settingsTimezone();
    return {
      ...event,
      eventAt: mysqlUtc(zonedLocalToUtc(event.eventAt, timeZone)),
      reminderAt: event.reminderAt
        ? mysqlUtc(zonedLocalToUtc(event.reminderAt, timeZone))
        : null,
    };
  }

  router.post('/events', async (req, res) => {
    if (requireDatabase(res, 'events')) return;
    try {
      const event = await eventValues(req.body);
      await getPool().execute(
        `INSERT INTO shared_events
          (title, event_at, reminder_at, notes, is_completed)
         VALUES (?, ?, ?, ?, ?)`,
        [event.title, event.eventAt, event.reminderAt, event.notes || null, event.isCompleted],
      );
      return redirectSettings(res, 'events', 'message', 'Event added.');
    } catch (error) {
      console.error('Admin event create failed:', error.message);
      return redirectSettings(res, 'events', 'error', error.message);
    }
  });

  router.post('/events/:id', async (req, res) => {
    if (requireDatabase(res, 'events')) return;
    try {
      const event = await eventValues(req.body);
      const [result] = await getPool().execute(
        `UPDATE shared_events
         SET title = ?, event_at = ?, reminder_at = ?, notes = ?,
             is_completed = ?, reminder_dismissed = FALSE
         WHERE id = ?`,
        [
          event.title,
          event.eventAt,
          event.reminderAt,
          event.notes || null,
          event.isCompleted,
          positiveId(req.params.id),
        ],
      );
      if (result.affectedRows !== 1) throw new Error('Event not found');
      return redirectSettings(res, 'events', 'message', 'Event updated.');
    } catch (error) {
      console.error('Admin event update failed:', error.message);
      return redirectSettings(res, 'events', 'error', error.message);
    }
  });

  router.post('/events/:id/delete', async (req, res) => {
    if (requireDatabase(res, 'events')) return;
    try {
      const [result] = await getPool().execute(
        'DELETE FROM shared_events WHERE id = ?',
        [positiveId(req.params.id)],
      );
      if (result.affectedRows !== 1) throw new Error('Event not found');
      return redirectSettings(res, 'events', 'message', 'Event deleted.');
    } catch (error) {
      console.error('Admin event delete failed:', error.message);
      return redirectSettings(res, 'events', 'error', error.message);
    }
  });

  router.get('/albums', async (req, res) => {
    let albums = [];
    let photos = [];
    let milestones = [];
    let dbError = null;
    if (isDbAvailable()) {
      try {
        [[albums], [photos], milestones] = await Promise.all([
          getPool().execute(
            `SELECT id, title, description,
                    DATE_FORMAT(album_date, '%Y-%m-%d') AS album_date,
                    display_order
             FROM photo_albums ORDER BY display_order, id`,
          ),
          getPool().execute(
            `SELECT id, album_id, milestone_id, caption,
                    DATE_FORMAT(photo_date, '%Y-%m-%d') AS photo_date,
                    display_order, storage_type, storage_name
             FROM album_photos ORDER BY album_id, display_order, id`,
          ),
          milestoneOptions(),
        ]);
      } catch (error) {
        console.error('Admin albums load failed:', error.message);
        dbError = 'Albums could not be loaded.';
      }
    } else dbError = 'The database is unavailable.';
    return res.render('settings-albums', {
      title: 'Manage Albums | GBAGL',
      page: 'settings',
      albums,
      photos,
      milestones,
      dbError,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  router.post('/albums', async (req, res) => {
    if (requireDatabase(res, 'albums')) return;
    try {
      const album = validateAlbum(req.body);
      await getPool().execute(
        `INSERT INTO photo_albums (title, description, album_date, display_order)
         VALUES (?, ?, ?, ?)`,
        [album.title, album.description, album.albumDate, album.displayOrder],
      );
      return redirectSettings(res, 'albums', 'message', 'Album added.');
    } catch (error) {
      console.error('Admin album create failed:', error.message);
      return redirectSettings(res, 'albums', 'error', error.message);
    }
  });

  router.post('/albums/:id', async (req, res) => {
    if (requireDatabase(res, 'albums')) return;
    try {
      const album = validateAlbum(req.body);
      const [result] = await getPool().execute(
        `UPDATE photo_albums
         SET title = ?, description = ?, album_date = ?, display_order = ?
         WHERE id = ?`,
        [
          album.title,
          album.description,
          album.albumDate,
          album.displayOrder,
          positiveId(req.params.id),
        ],
      );
      if (result.affectedRows !== 1) throw new Error('Album not found');
      return redirectSettings(res, 'albums', 'message', 'Album updated.');
    } catch (error) {
      console.error('Admin album update failed:', error.message);
      return redirectSettings(res, 'albums', 'error', error.message);
    }
  });

  router.post('/albums/:id/delete', async (req, res) => {
    if (requireDatabase(res, 'albums')) return;
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
            console.error('Admin album delete rollback failed:', rollbackError.message);
          }
        }
        console.error('Admin album delete failed:', error.message);
        return redirectSettings(res, 'albums', 'error', error.message);
      } finally {
        if (connection) connection.release();
      }
      const cleanup = await Promise.allSettled(
        uploads.map((photo) => removeUpload(config.uploadDir, photo.storage_name)),
      );
      const failed = cleanup.filter((resultItem) => resultItem.status === 'rejected');
      if (!failed.length) return redirectSettings(res, 'albums', 'message', 'Album deleted.');
      failed.forEach((resultItem) => console.error(
        'Deleted album media cleanup failed:',
        resultItem.reason.message,
      ));
      return redirectSettings(
        res,
        'albums',
        'error',
        'Album deleted, but one or more orphaned upload files require cleanup.',
      );
    });
  });

  router.post('/albums/photos/upload', async (req, res) => {
    if (requireDatabase(res, 'albums')) return;
    return withMediaOperation(async () => {
      let stored = null;
      try {
        const photo = validatePhoto(req.body);
        stored = await inspectAndStoreUpload(req.file, config.uploadDir);
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
            photo.displayOrder,
            stored.storageName,
            stored.mediaType,
          ],
        );
        if (result.affectedRows !== 1) throw new Error('Photo was not saved');
        return redirectSettings(res, 'albums', 'message', 'Photo uploaded.');
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
        console.error('Admin photo upload failed:', error.message);
        return redirectSettings(res, 'albums', 'error', error.message);
      }
    });
  });

  router.post('/albums/photos/existing', async (req, res) => {
    if (requireDatabase(res, 'albums')) return;
    try {
      const photo = validatePhoto(req.body);
      const storageName = existingImageName(req.body.existing_image);
      const imagePath = path.resolve(__dirname, '..', 'public', 'images', storageName);
      const expectedRoot = path.resolve(__dirname, '..', 'public', 'images');
      if (path.dirname(imagePath) !== expectedRoot) throw new Error('Invalid existing image path');
      const mediaType = await inspectExistingImage(imagePath);
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
          photo.displayOrder,
          storageName,
          mediaType,
        ],
      );
      return redirectSettings(res, 'albums', 'message', 'Existing photo linked.');
    } catch (error) {
      console.error('Existing photo link failed:', error.message);
      return redirectSettings(res, 'albums', 'error', error.message);
    }
  });

  router.post('/albums/photos/:id', async (req, res) => {
    if (requireDatabase(res, 'albums')) return;
    return withMediaOperation(async () => {
      try {
        const photo = validatePhoto(req.body);
        const [result] = await getPool().execute(
          `UPDATE album_photos
           SET album_id = ?, milestone_id = ?, caption = ?, photo_date = ?,
               display_order = ?
           WHERE id = ?`,
          [
            photo.albumId,
            photo.milestoneId,
            photo.caption || null,
            photo.photoDate,
            photo.displayOrder,
            positiveId(req.params.id),
          ],
        );
        if (result.affectedRows !== 1) throw new Error('Photo not found');
        return redirectSettings(res, 'albums', 'message', 'Photo details updated.');
      } catch (error) {
        console.error('Admin photo update failed:', error.message);
        return redirectSettings(res, 'albums', 'error', error.message);
      }
    });
  });

  router.post('/albums/photos/:id/delete', async (req, res) => {
    if (requireDatabase(res, 'albums')) return;
    return withMediaOperation(async () => {
      try {
        const id = positiveId(req.params.id);
        const [rows] = await getPool().execute(
          'SELECT storage_type, storage_name FROM album_photos WHERE id = ?',
          [id],
        );
        if (!rows[0]) throw new Error('Photo not found');
        await getPool().execute('DELETE FROM album_photos WHERE id = ?', [id]);
        if (rows[0].storage_type === 'upload') {
          try {
            await removeUpload(config.uploadDir, rows[0].storage_name);
          } catch (cleanupError) {
            console.error('Deleted photo media cleanup failed:', cleanupError.message);
            return redirectSettings(
              res,
              'albums',
              'error',
              'Photo record deleted, but the orphaned upload file requires cleanup.',
            );
          }
        }
        return redirectSettings(res, 'albums', 'message', 'Photo deleted.');
      } catch (error) {
        console.error('Admin photo delete failed:', error.message);
        return redirectSettings(res, 'albums', 'error', error.message);
      }
    });
  });

  router.get('/journals', async (req, res) => {
    let entries = [];
    let milestones = [];
    let dbError = null;
    if (isDbAvailable()) {
      try {
        [[entries], milestones] = await Promise.all([
          getPool().execute(
            `SELECT id, milestone_id, title, body,
                    DATE_FORMAT(entry_date, '%Y-%m-%d') AS entry_date
             FROM journal_entries ORDER BY entry_date DESC, id DESC`,
          ),
          milestoneOptions(),
        ]);
      } catch (error) {
        console.error('Admin journal load failed:', error.message);
        dbError = 'Journal entries could not be loaded.';
      }
    } else dbError = 'The database is unavailable.';
    return res.render('settings-journals', {
      title: 'Manage Journal | GBAGL',
      page: 'settings',
      entries,
      milestones,
      dbError,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  router.post('/journals', async (req, res) => {
    if (requireDatabase(res, 'journals')) return;
    try {
      const entry = validateJournal(req.body);
      await getPool().execute(
        `INSERT INTO journal_entries (milestone_id, title, body, entry_date)
         VALUES (?, ?, ?, ?)`,
        [entry.milestoneId, entry.title, entry.body, entry.entryDate],
      );
      return redirectSettings(res, 'journals', 'message', 'Journal entry added.');
    } catch (error) {
      console.error('Admin journal create failed:', error.message);
      return redirectSettings(res, 'journals', 'error', error.message);
    }
  });

  router.post('/journals/:id', async (req, res) => {
    if (requireDatabase(res, 'journals')) return;
    try {
      const entry = validateJournal(req.body);
      const [result] = await getPool().execute(
        `UPDATE journal_entries
         SET milestone_id = ?, title = ?, body = ?, entry_date = ?
         WHERE id = ?`,
        [
          entry.milestoneId,
          entry.title,
          entry.body,
          entry.entryDate,
          positiveId(req.params.id),
        ],
      );
      if (result.affectedRows !== 1) throw new Error('Journal entry not found');
      return redirectSettings(res, 'journals', 'message', 'Journal entry updated.');
    } catch (error) {
      console.error('Admin journal update failed:', error.message);
      return redirectSettings(res, 'journals', 'error', error.message);
    }
  });

  router.post('/journals/:id/delete', async (req, res) => {
    if (requireDatabase(res, 'journals')) return;
    try {
      const [result] = await getPool().execute(
        'DELETE FROM journal_entries WHERE id = ?',
        [positiveId(req.params.id)],
      );
      if (result.affectedRows !== 1) throw new Error('Journal entry not found');
      return redirectSettings(res, 'journals', 'message', 'Journal entry deleted.');
    } catch (error) {
      console.error('Admin journal delete failed:', error.message);
      return redirectSettings(res, 'journals', 'error', error.message);
    }
  });

  return router;
}

module.exports = { createSettingsContentRouter, createUploadIngress };
