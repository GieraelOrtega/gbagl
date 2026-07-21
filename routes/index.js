/**
 * routes/index.js — Landing page
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getPool, isDbAvailable } = require('../db');
const { nextAnniversary } = require('../lib/dates');
const {
  inspectAndStoreUpload,
  removeUpload,
  safeUploadPath,
} = require('../lib/media');
const { formatDate, formatDateTime } = require('../lib/presentation');
const { MEDIA_OPT_IN, PRIVATE_SNAPSHOT_HEADER } = require('../public/js/pwaPolicy');
const { withMediaOperation } = require('../services/mediaCoordinator');

const HOME_PHOTO_NAME_KEY = 'home_photo_storage_name';
const HOME_PHOTO_TYPE_KEY = 'home_photo_media_type';

function redirectHome(res, type, message) {
  return res.redirect(303, `/?${new URLSearchParams({ [type]: message })}`);
}

async function replaceHomePhoto({
  databasePool,
  file,
  uploadDir,
  inspectUpload = inspectAndStoreUpload,
  removeStoredUpload = removeUpload,
}) {
  let stored = null;
  let connection = null;
  let transactionStarted = false;
  let previousStorageName = null;
  try {
    stored = await inspectUpload(file, uploadDir);
    connection = await databasePool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.execute(
      `SELECT setting_key, setting_value FROM site_settings
       WHERE setting_key IN (?, ?) FOR UPDATE`,
      [HOME_PHOTO_NAME_KEY, HOME_PHOTO_TYPE_KEY],
    );
    previousStorageName = rows.find(
      (row) => row.setting_key === HOME_PHOTO_NAME_KEY,
    )?.setting_value || null;
    await connection.query(
      `INSERT INTO site_settings (setting_key, setting_value) VALUES ?
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [[
        [HOME_PHOTO_NAME_KEY, stored.storageName],
        [HOME_PHOTO_TYPE_KEY, stored.mediaType],
      ]],
    );
    await connection.commit();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Home photo rollback failed:', rollbackError.message);
      }
    }
    if (stored) {
      await removeStoredUpload(uploadDir, stored.storageName).catch((cleanupError) => {
        console.error('Rejected home photo cleanup failed:', cleanupError.message);
      });
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }

  let cleanupError = null;
  if (previousStorageName && previousStorageName !== stored.storageName) {
    try {
      await removeStoredUpload(uploadDir, previousStorageName);
    } catch (error) {
      cleanupError = error;
    }
  }
  return { cleanupError, ...stored };
}

function createIndexRouter(config, accountAuth) {
  const router = express.Router();

  router.get('/media/home-photo', async (req, res) => {
    let filePath = path.resolve(__dirname, '..', 'public', 'images', 'photo-1.svg');
    let mediaType = 'image/svg+xml';
    if (isDbAvailable()) {
      try {
        const [rows] = await getPool().execute(
          `SELECT setting_key, setting_value FROM site_settings
           WHERE setting_key IN (?, ?)`,
          [HOME_PHOTO_NAME_KEY, HOME_PHOTO_TYPE_KEY],
        );
        const settings = Object.fromEntries(
          rows.map((row) => [row.setting_key, row.setting_value]),
        );
        if (settings[HOME_PHOTO_NAME_KEY] && settings[HOME_PHOTO_TYPE_KEY]) {
          const candidate = safeUploadPath(
            config.uploadDir,
            settings[HOME_PHOTO_NAME_KEY],
          );
          await fs.promises.access(candidate, fs.constants.R_OK);
          filePath = candidate;
          mediaType = settings[HOME_PHOTO_TYPE_KEY];
        }
      } catch (error) {
        console.error('Home photo load failed; using fallback:', error.message);
      }
    }
    res.set({
      'Content-Type': mediaType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      [PRIVATE_SNAPSHOT_HEADER]: MEDIA_OPT_IN,
      'X-Content-Type-Options': 'nosniff',
    });
    return res.sendFile(filePath);
  });

  router.post('/home-photo', accountAuth.requireMember, async (req, res) => {
    if (!isDbAvailable()) return redirectHome(res, 'error', 'Database unavailable.');
    return withMediaOperation(async () => {
      try {
        const result = await replaceHomePhoto({
          databasePool: getPool(),
          file: req.file,
          uploadDir: config.uploadDir,
        });
        if (result.cleanupError) {
          console.error('Previous home photo cleanup failed:', result.cleanupError.message);
          return redirectHome(
            res,
            'error',
            'Home photo updated, but the previous file requires cleanup.',
          );
        }
        return redirectHome(res, 'message', 'Home photo updated.');
      } catch (error) {
        console.error('Home photo update failed:', error.message);
        return redirectHome(res, 'error', error.message);
      }
    });
  });

  router.get('/', async (req, res) => {
    let settings = {};
    let countdown = null;
    let anniversaryDisplay = null;
    let upcomingEvents = [];
    let bucketProgress = { completed: 0, total: 0 };
    let dbError = null;
    if (!isDbAvailable()) {
      dbError = 'Dashboard summaries are unavailable because the database is offline.';
    } else {
      try {
        const [[settingRows], [eventRows], [bucketRows]] = await Promise.all([
          getPool().execute(
            `SELECT setting_key, setting_value FROM site_settings
             WHERE setting_key IN (
               'partner_one_name', 'partner_two_name', 'anniversary_date', 'timezone'
             )`,
          ),
          getPool().execute(
            `SELECT id, title,
                    DATE_FORMAT(event_at, '%Y-%m-%dT%H:%i:%sZ') AS event_at
             FROM shared_events
             WHERE event_at >= UTC_TIMESTAMP() AND is_completed = FALSE
             ORDER BY event_at LIMIT 3`,
          ),
          getPool().execute(
            `SELECT COUNT(*) AS total,
                    SUM(completed_at IS NOT NULL) AS completed
             FROM bucket_items`,
          ),
        ]);
        settings = Object.fromEntries(
          settingRows.map((row) => [row.setting_key, row.setting_value]),
        );
        countdown = nextAnniversary(
          settings.anniversary_date,
          settings.timezone || 'UTC',
        );
        anniversaryDisplay = settings.anniversary_date
          ? formatDate(settings.anniversary_date)
          : null;
        upcomingEvents = eventRows;
        bucketProgress = {
          completed: Number(bucketRows[0]?.completed || 0),
          total: Number(bucketRows[0]?.total || 0),
        };
      } catch (error) {
        console.error('Home dashboard load failed:', error.message);
        dbError = 'Dashboard summaries could not be loaded.';
      }
    }
    if (!dbError) res.allowPrivateSnapshot?.();
    res.render('index', {
      title: 'GBAGL — Gunna Be a Great Life',
      page: 'home',
      settings,
      countdown,
      anniversaryDisplay,
      upcomingEvents,
      bucketProgress,
      formatDateTime,
      dbError,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  return router;
}

module.exports = {
  HOME_PHOTO_NAME_KEY,
  HOME_PHOTO_TYPE_KEY,
  createIndexRouter,
  replaceHomePhoto,
};
