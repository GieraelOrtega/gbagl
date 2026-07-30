/**
 * routes/timeline.js — Our Timeline page
 */

const express = require('express');
const fs = require('fs');
const fallbackMilestones = require('../data/timeline');
const {
  TIMELINE_IMPORT_MARKER,
  getPool,
  isDbAvailable,
} = require('../db');
const {
  nextDisplayOrder,
  publicOrderError,
  reorderCollection,
} = require('../lib/contentOrder');
const {
  inspectAndStoreUpload,
  removeUpload,
} = require('../lib/media');
const { timelinePhotoDetails } = require('../lib/timelinePhoto');
const { positiveId, validateMilestone } = require('../lib/validation');
const { MEDIA_OPT_IN, PRIVATE_SNAPSHOT_HEADER } = require('../public/js/pwaPolicy');
const { withMediaOperation } = require('../services/mediaCoordinator');

function redirectMessage(res, type, message, id = null) {
  const query = new URLSearchParams({ [type]: message, edit: '1' });
  const hash = id ? `#milestone-${id}` : '';
  return res.redirect(303, `/timeline?${query}${hash}`);
}

function photoRemovalRequested(body) {
  const value = body?.remove_photo;
  if (value === undefined || value === '') return false;
  if (value !== '1') throw new Error('Invalid photo removal choice');
  return true;
}

async function cleanupRejectedUpload(uploadDir, stored, removeStoredUpload, error) {
  if (!stored) return;
  try {
    await removeStoredUpload(uploadDir, stored.storageName);
  } catch (cleanupError) {
    console.error('Rejected timeline upload cleanup failed:', cleanupError.message);
    error.cleanupError = cleanupError;
  }
}

async function cleanupCommittedUpload(uploadDir, storageName, removeStoredUpload) {
  if (!storageName) return [];
  try {
    await removeStoredUpload(uploadDir, storageName);
    return [];
  } catch (error) {
    return [error];
  }
}

function timelineMutationMatches(row, expected) {
  return row
    && Object.entries(expected).every(([key, value]) => (
      (row[key] ?? null) === (value ?? null)
    ));
}

async function commitWithVerification({
  connection,
  operation,
  uncertainMessage,
  verifyCommitted,
}) {
  try {
    await connection.commit();
  } catch (commitError) {
    let committed;
    try {
      committed = await verifyCommitted();
    } catch (verificationError) {
      console.error(
        `Timeline ${operation} commit verification failed:`,
        verificationError.message,
      );
      const uncertainError = new Error(uncertainMessage);
      uncertainError.cause = commitError;
      uncertainError.commitOutcomeUnknown = true;
      uncertainError.verificationError = verificationError;
      throw uncertainError;
    }
    if (!committed) throw commitError;
    console.error(
      `Timeline ${operation} commit response failed, but the database confirmed it:`,
      commitError.message,
    );
  }
}

async function verifyTimelineMutation(databasePool, id, expected) {
  const [rows] = await databasePool.execute(
    `SELECT milestone_date AS date, title, description, emoji, photo,
            photo_storage_type, photo_media_type, link_url AS linkUrl
     FROM timeline_milestones WHERE id = ?`,
    [id],
  );
  return timelineMutationMatches(rows[0], expected);
}

async function rollbackTimelineOperation(connection, operation, error) {
  try {
    await connection.rollback();
    return true;
  } catch (rollbackError) {
    console.error(`Timeline ${operation} rollback failed:`, rollbackError.message);
    error.rollbackError = rollbackError;
    return false;
  }
}

async function createTimelineMilestone({
  body,
  databasePool,
  file,
  inspectUpload = inspectAndStoreUpload,
  removeStoredUpload = removeUpload,
  uploadDir,
}) {
  const milestone = validateMilestone(body);
  let stored = null;
  let connection = null;
  let transactionStarted = false;
  let cleanupSafe = true;
  try {
    if (file) stored = await inspectUpload(file, uploadDir);
    connection = await databasePool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const displayOrder = await nextDisplayOrder(connection, 'timeline');
    const [result] = await connection.execute(
      `INSERT INTO timeline_milestones
        (display_order, milestone_date, title, description, emoji, photo,
         photo_storage_type, photo_media_type, link_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        displayOrder,
        milestone.date,
        milestone.title,
        milestone.description,
        milestone.emoji,
        stored?.storageName || null,
        stored ? 'upload' : null,
        stored?.mediaType || null,
        milestone.linkUrl,
      ],
    );
    const id = Number(result.insertId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Milestone was not saved');
    await commitWithVerification({
      connection,
      operation: 'create',
      uncertainMessage: stored
        ? 'Milestone save status could not be confirmed. Refresh Timeline before trying again; the new photo was preserved.'
        : 'Milestone save status could not be confirmed. Refresh Timeline before trying again.',
      verifyCommitted: () => verifyTimelineMutation(databasePool, id, {
        date: milestone.date,
        description: milestone.description,
        emoji: milestone.emoji,
        linkUrl: milestone.linkUrl,
        photo: stored?.storageName || null,
        photo_media_type: stored?.mediaType || null,
        photo_storage_type: stored ? 'upload' : null,
        title: milestone.title,
      }),
    });
    transactionStarted = false;
    return id;
  } catch (error) {
    if (transactionStarted) {
      const rolledBack = await rollbackTimelineOperation(connection, 'create', error);
      cleanupSafe = !error.commitOutcomeUnknown && rolledBack;
    }
    if (cleanupSafe) {
      await cleanupRejectedUpload(uploadDir, stored, removeStoredUpload, error);
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

async function updateTimelineMilestone({
  body,
  databasePool,
  file,
  id: idValue,
  inspectUpload = inspectAndStoreUpload,
  removeStoredUpload = removeUpload,
  uploadDir,
}) {
  const id = positiveId(String(idValue));
  const milestone = validateMilestone(body);
  const removePhoto = photoRemovalRequested(body);
  if (file && removePhoto) {
    throw new Error('Choose a new photo or remove the current photo, not both');
  }

  let stored = null;
  let connection = null;
  let transactionStarted = false;
  let previousUpload = null;
  let cleanupSafe = true;
  try {
    if (file) stored = await inspectUpload(file, uploadDir);
    connection = await databasePool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.execute(
      `SELECT photo, photo_storage_type, photo_media_type
       FROM timeline_milestones WHERE id = ? FOR UPDATE`,
      [id],
    );
    if (!rows[0]) throw new Error('Milestone not found');
    const current = rows[0];
    if (removePhoto && !current.photo) throw new Error('This milestone has no photo to remove');

    const photo = stored ? stored.storageName : (removePhoto ? null : current.photo);
    const photoStorageType = stored
      ? 'upload'
      : (removePhoto ? null : (current.photo_storage_type || (current.photo ? 'existing' : null)));
    const photoMediaType = stored
      ? stored.mediaType
      : (removePhoto ? null : current.photo_media_type);
    const expected = {
      date: milestone.date,
      description: milestone.description,
      emoji: milestone.emoji,
      linkUrl: milestone.linkUrl,
      photo,
      photo_media_type: photoMediaType,
      photo_storage_type: photoStorageType,
      title: milestone.title,
    };
    await connection.execute(
      `UPDATE timeline_milestones
       SET milestone_date = ?, title = ?, description = ?, emoji = ?, photo = ?,
           photo_storage_type = ?, photo_media_type = ?, link_url = ?
       WHERE id = ?`,
      [
        milestone.date,
        milestone.title,
        milestone.description,
        milestone.emoji,
        photo,
        photoStorageType,
        photoMediaType,
        milestone.linkUrl,
        id,
      ],
    );
    if (
      current.photo
      && current.photo_storage_type === 'upload'
      && current.photo !== photo
    ) previousUpload = current.photo;
    await commitWithVerification({
      connection,
      operation: 'update',
      uncertainMessage: stored
        ? 'Milestone update status could not be confirmed. Refresh Timeline before trying again; the new photo was preserved.'
        : 'Milestone update status could not be confirmed. Refresh Timeline before trying again.',
      verifyCommitted: () => verifyTimelineMutation(
        databasePool,
        id,
        stored || removePhoto
          ? {
            photo,
            photo_media_type: photoMediaType,
            photo_storage_type: photoStorageType,
          }
          : expected,
      ),
    });
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      const rolledBack = await rollbackTimelineOperation(connection, 'update', error);
      cleanupSafe = !error.commitOutcomeUnknown && rolledBack;
    }
    if (cleanupSafe) {
      await cleanupRejectedUpload(uploadDir, stored, removeStoredUpload, error);
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }

  const cleanupErrors = await cleanupCommittedUpload(
    uploadDir,
    previousUpload,
    removeStoredUpload,
  );
  return { cleanupErrors, id };
}

async function deleteTimelineMilestone({
  databasePool,
  id: idValue,
  removeStoredUpload = removeUpload,
  uploadDir,
}) {
  const id = positiveId(String(idValue));
  const connection = await databasePool.getConnection();
  let transactionStarted = false;
  let uploadedPhoto = null;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.execute(
      `SELECT photo, photo_storage_type
       FROM timeline_milestones WHERE id = ? FOR UPDATE`,
      [id],
    );
    if (!rows[0]) throw new Error('Milestone not found');
    if (rows[0].photo && rows[0].photo_storage_type === 'upload') {
      uploadedPhoto = rows[0].photo;
    }
    await connection.execute('DELETE FROM timeline_milestones WHERE id = ?', [id]);
    await commitWithVerification({
      connection,
      operation: 'delete',
      uncertainMessage: 'Milestone deletion status could not be confirmed. Refresh Timeline before trying again.',
      verifyCommitted: async () => {
        const [remaining] = await databasePool.execute(
          'SELECT id FROM timeline_milestones WHERE id = ?',
          [id],
        );
        return remaining.length === 0;
      },
    });
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await rollbackTimelineOperation(connection, 'delete', error);
    }
    throw error;
  } finally {
    connection.release();
  }
  const cleanupErrors = await cleanupCommittedUpload(
    uploadDir,
    uploadedPhoto,
    removeStoredUpload,
  );
  return { cleanupErrors, id };
}

async function loadTimelinePhoto({
  access = fs.promises.access,
  config,
  databasePool,
  id: idValue,
}) {
  const id = positiveId(String(idValue));
  const [rows] = await databasePool.execute(
    `SELECT photo, photo_storage_type, photo_media_type
     FROM timeline_milestones WHERE id = ?`,
    [id],
  );
  if (!rows[0]?.photo) throw new Error('Timeline photo not found');
  const details = timelinePhotoDetails(config, rows[0]);
  await access(details.filePath, fs.constants.R_OK);
  return details;
}

async function loadMilestonesResult({
  databaseAvailable = isDbAvailable,
  databasePool = getPool,
  fallback = fallbackMilestones,
} = {}) {
  if (!databaseAvailable()) return { milestones: fallback, degraded: true };
  try {
    const pool = databasePool();
    const [rows] = await pool.execute(
      `SELECT id, display_order, milestone_date AS date, title, description, emoji,
              photo, photo_storage_type, photo_media_type, link_url
       FROM timeline_milestones ORDER BY display_order, id`,
    );
    if (rows.length > 0) return { milestones: rows, degraded: false };

    const [markerRows] = await pool.execute(
      `SELECT setting_value FROM site_settings
       WHERE setting_key = ?`,
      [TIMELINE_IMPORT_MARKER],
    );
    if (markerRows[0]?.setting_value !== 'complete') {
      console.error('Timeline import is incomplete; using file fallback.');
      return { milestones: fallback, degraded: true };
    }
    return { milestones: rows, degraded: false };
  } catch (error) {
    console.error('Timeline database load failed; using file fallback:', error.message);
    return { milestones: fallback, degraded: true };
  }
}

async function loadMilestones(dependencies = {}) {
  return (await loadMilestonesResult(dependencies)).milestones;
}

function createTimelineRouter(config, dependencies = {}) {
  const router = express.Router();
  const databaseAvailable = dependencies.isDbAvailable || isDbAvailable;
  const databasePool = dependencies.getPool || getPool;
  const coordinateMedia = dependencies.withMediaOperation || withMediaOperation;

  router.get('/photos/:id/content', async (req, res, next) => {
    if (!databaseAvailable()) return res.status(503).end();
    try {
      const photo = await loadTimelinePhoto({
        config,
        databasePool: databasePool(),
        id: req.params.id,
      });
      res.set({
        'Content-Type': photo.mediaType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        [PRIVATE_SNAPSHOT_HEADER]: MEDIA_OPT_IN,
        'X-Content-Type-Options': 'nosniff',
      });
      return res.sendFile(photo.filePath);
    } catch (error) {
      console.error('Protected timeline photo load failed:', error.message);
      return next();
    }
  });

  router.get('/', async (req, res) => {
    const {
      milestones,
      degraded: timelineDegraded,
    } = await loadMilestonesResult({ databaseAvailable, databasePool });
    let journals = [];
    let journalError = null;
    if (!databaseAvailable()) {
      journalError = 'Linked journal entries are unavailable while the database is offline.';
    } else {
      try {
        [journals] = await databasePool().execute(
          `SELECT id, milestone_id, title, body,
                  DATE_FORMAT(entry_date, '%Y-%m-%d') AS entry_date,
                  display_order
           FROM journal_entries WHERE milestone_id IS NOT NULL
           ORDER BY display_order, entry_date DESC, id DESC`,
        );
      } catch (error) {
        console.error('Timeline journal load failed:', error.message);
        journalError = 'Linked journal entries could not be loaded.';
      }
    }
    if (!journalError && !timelineDegraded) res.allowPrivateSnapshot?.();
    res.render('timeline', {
      title: 'Our Timeline — GBAGL',
      page: 'timeline',
      milestones,
      journals,
      journalError,
      timelineDegraded,
      editMode: req.query.edit === '1',
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  router.post('/', async (req, res) => {
    if (!databaseAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    return coordinateMedia(async () => {
      try {
        const id = await createTimelineMilestone({
          body: req.body,
          databasePool: databasePool(),
          file: req.file,
          uploadDir: config.uploadDir,
        });
        return redirectMessage(res, 'message', 'Milestone added.', id);
      } catch (error) {
        console.error('Milestone create failed:', error.message);
        return redirectMessage(res, 'error', error.message);
      }
    });
  });

  router.post('/reorder', async (req, res) => {
    if (!databaseAvailable()) return res.status(503).json({ error: 'Database unavailable' });
    try {
      await reorderCollection(databasePool(), 'timeline', req.body.ids);
      return res.status(204).end();
    } catch (error) {
      console.error('Timeline reorder failed:', error.message);
      const publicError = publicOrderError(error);
      return res.status(publicError.status).json({ error: publicError.message });
    }
  });

  router.post('/:id', async (req, res) => {
    if (!databaseAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    return coordinateMedia(async () => {
      try {
        const result = await updateTimelineMilestone({
          body: req.body,
          databasePool: databasePool(),
          file: req.file,
          id: req.params.id,
          uploadDir: config.uploadDir,
        });
        if (result.cleanupErrors.length) {
          result.cleanupErrors.forEach((error) => console.error(
            'Replaced timeline photo cleanup failed:',
            error.message,
          ));
          return redirectMessage(
            res,
            'error',
            'Milestone updated, but its previous uploaded photo requires cleanup.',
            result.id,
          );
        }
        return redirectMessage(res, 'message', 'Milestone updated.', result.id);
      } catch (error) {
        console.error('Milestone update failed:', error.message);
        return redirectMessage(res, 'error', error.message);
      }
    });
  });

  router.post('/:id/delete', async (req, res) => {
    if (!databaseAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    return coordinateMedia(async () => {
      try {
        const result = await deleteTimelineMilestone({
          databasePool: databasePool(),
          id: req.params.id,
          uploadDir: config.uploadDir,
        });
        if (result.cleanupErrors.length) {
          result.cleanupErrors.forEach((error) => console.error(
            'Deleted timeline photo cleanup failed:',
            error.message,
          ));
          return redirectMessage(
            res,
            'error',
            'Milestone deleted, but its orphaned uploaded photo requires cleanup.',
          );
        }
        return redirectMessage(res, 'message', 'Milestone deleted.');
      } catch (error) {
        console.error('Milestone delete failed:', error.message);
        return redirectMessage(res, 'error', error.message);
      }
    });
  });

  return router;
}

module.exports = {
  createTimelineMilestone,
  createTimelineRouter,
  deleteTimelineMilestone,
  loadMilestones,
  loadMilestonesResult,
  loadTimelinePhoto,
  photoRemovalRequested,
  updateTimelineMilestone,
};
