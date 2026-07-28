const express = require('express');
const { JOURNAL_SYSTEM_ALBUM_KEY, getPool, isDbAvailable } = require('../db');
const {
  publicOrderError,
  reorderCollection,
} = require('../lib/contentOrder');
const { validateJournal } = require('../lib/hubValidation');
const {
  inspectAndStoreUpload,
  removeUpload,
} = require('../lib/media');
const { positiveId, text } = require('../lib/validation');
const { withMediaOperation } = require('../services/mediaCoordinator');

function redirectMessage(res, type, message, entryId = null) {
  const anchor = entryId ? `#journal-entry-${entryId}` : '';
  return res.redirect(
    303,
    `/journal?${new URLSearchParams({ [type]: message })}${anchor}`,
  );
}

function photoCaption(body) {
  return text(body.photo_caption, 'Photo caption', 1000, { required: false });
}

async function journalSystemAlbumId(connection) {
  const [rows] = await connection.execute(
    'SELECT id FROM photo_albums WHERE system_key = ?',
    [JOURNAL_SYSTEM_ALBUM_KEY],
  );
  const id = Number(rows[0]?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Journal photo storage is not initialized');
  }
  return id;
}

async function insertJournalPhoto(connection, {
  caption,
  entryDate,
  journalEntryId,
  mediaType,
  milestoneId,
  storageName,
}) {
  const [entries] = await connection.execute(
    `SELECT id FROM journal_entries
     WHERE id = ? FOR UPDATE`,
    [journalEntryId],
  );
  if (!entries[0]) throw new Error('Journal entry not found');
  const [orderRows] = await connection.execute(
    `SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order
     FROM album_photos WHERE journal_entry_id = ?`,
    [journalEntryId],
  );
  const displayOrder = Number(orderRows[0]?.next_order);
  if (!Number.isSafeInteger(displayOrder) || displayOrder < 0) {
    throw new Error('Could not determine the next photo order');
  }
  const albumId = await journalSystemAlbumId(connection);
  const [result] = await connection.execute(
    `INSERT INTO album_photos
      (album_id, journal_entry_id, milestone_id, caption, photo_date,
       display_order, storage_type, storage_name, media_type)
     VALUES (?, ?, ?, ?, ?, ?, 'upload', ?, ?)`,
    [
      albumId,
      journalEntryId,
      milestoneId,
      caption || null,
      entryDate,
      displayOrder,
      storageName,
      mediaType,
    ],
  );
  if (result.affectedRows !== 1) throw new Error('Photo was not saved');
  return Number(result.insertId);
}

async function cleanupRejectedUpload(uploadDir, stored, removeStoredUpload, error) {
  if (!stored) return;
  try {
    await removeStoredUpload(uploadDir, stored.storageName);
  } catch (cleanupError) {
    console.error('Rejected journal upload cleanup failed:', cleanupError.message);
    error.cleanupError = cleanupError;
  }
}

async function createJournalEntry({
  body,
  databasePool,
  file,
  inspectUpload = inspectAndStoreUpload,
  removeStoredUpload = removeUpload,
  uploadDir,
}) {
  const entry = validateJournal(body);
  const caption = photoCaption(body);
  let stored = null;
  let connection = null;
  let transactionStarted = false;
  try {
    if (file) stored = await inspectUpload(file, uploadDir);
    connection = await databasePool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [orderRows] = await connection.execute(
      'SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM journal_entries',
    );
    const displayOrder = Number(orderRows[0]?.next_order);
    if (!Number.isSafeInteger(displayOrder) || displayOrder < 0) {
      throw new Error('Could not determine the next journal order');
    }
    const [result] = await connection.execute(
      `INSERT INTO journal_entries
        (milestone_id, title, body, entry_date, display_order)
       VALUES (?, ?, ?, ?, ?)`,
      [
        entry.milestoneId,
        entry.title,
        entry.body,
        entry.entryDate,
        displayOrder,
      ],
    );
    const entryId = Number(result.insertId);
    if (stored) {
      await insertJournalPhoto(connection, {
        caption,
        entryDate: entry.entryDate,
        journalEntryId: entryId,
        mediaType: stored.mediaType,
        milestoneId: entry.milestoneId,
        storageName: stored.storageName,
      });
    }
    await connection.commit();
    transactionStarted = false;
    return entryId;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Journal create rollback failed:', rollbackError.message);
      }
    }
    await cleanupRejectedUpload(uploadDir, stored, removeStoredUpload, error);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

async function addJournalPhoto({
  body,
  databasePool,
  entryId: entryIdValue,
  file,
  inspectUpload = inspectAndStoreUpload,
  removeStoredUpload = removeUpload,
  uploadDir,
}) {
  const entryId = positiveId(String(entryIdValue));
  const caption = photoCaption(body);
  let stored = null;
  let connection = null;
  let transactionStarted = false;
  try {
    stored = await inspectUpload(file, uploadDir);
    connection = await databasePool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [entries] = await connection.execute(
      `SELECT milestone_id, DATE_FORMAT(entry_date, '%Y-%m-%d') AS entry_date
       FROM journal_entries WHERE id = ? FOR UPDATE`,
      [entryId],
    );
    if (!entries[0]) throw new Error('Journal entry not found');
    await insertJournalPhoto(connection, {
      caption,
      entryDate: entries[0].entry_date,
      journalEntryId: entryId,
      mediaType: stored.mediaType,
      milestoneId: entries[0].milestone_id,
      storageName: stored.storageName,
    });
    await connection.commit();
    transactionStarted = false;
    return entryId;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Journal photo rollback failed:', rollbackError.message);
      }
    }
    await cleanupRejectedUpload(uploadDir, stored, removeStoredUpload, error);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

async function updateJournalEntry(databasePool, idValue, body) {
  const id = positiveId(String(idValue));
  const entry = validateJournal(body);
  const connection = await databasePool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [result] = await connection.execute(
      `UPDATE journal_entries
       SET milestone_id = ?, title = ?, body = ?, entry_date = ?
       WHERE id = ?`,
      [entry.milestoneId, entry.title, entry.body, entry.entryDate, id],
    );
    if (result.affectedRows !== 1) throw new Error('Journal entry not found');
    await connection.commit();
    transactionStarted = false;
    return id;
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cleanupCommittedUploads(uploadDir, uploads, removeStoredUpload) {
  const cleanup = await Promise.allSettled(
    uploads.map((photo) => removeStoredUpload(uploadDir, photo.storage_name)),
  );
  return cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
}

async function deleteJournalPhoto({
  databasePool,
  entryId: entryIdValue,
  photoId: photoIdValue,
  removeStoredUpload = removeUpload,
  uploadDir,
}) {
  const entryId = positiveId(String(entryIdValue));
  const photoId = positiveId(String(photoIdValue));
  const connection = await databasePool.getConnection();
  let transactionStarted = false;
  let upload = null;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [rows] = await connection.execute(
      `SELECT storage_type, storage_name FROM album_photos
       WHERE id = ? AND journal_entry_id = ? FOR UPDATE`,
      [photoId, entryId],
    );
    if (!rows[0]) throw new Error('Photo not found');
    upload = rows[0].storage_type === 'upload' ? rows[0] : null;
    await connection.execute(
      'DELETE FROM album_photos WHERE id = ? AND journal_entry_id = ?',
      [photoId, entryId],
    );
    await connection.commit();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const cleanupErrors = upload
    ? await cleanupCommittedUploads(uploadDir, [upload], removeStoredUpload)
    : [];
  return { cleanupErrors, entryId };
}

async function deleteJournalEntry({
  databasePool,
  entryId: entryIdValue,
  removeStoredUpload = removeUpload,
  uploadDir,
}) {
  const entryId = positiveId(String(entryIdValue));
  const connection = await databasePool.getConnection();
  let transactionStarted = false;
  let uploads = [];
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [entries] = await connection.execute(
      'SELECT source_album_id FROM journal_entries WHERE id = ? FOR UPDATE',
      [entryId],
    );
    if (!entries[0]) throw new Error('Journal entry not found');
    const sourceAlbumId = Number(entries[0].source_album_id) || null;
    const params = sourceAlbumId ? [entryId, sourceAlbumId] : [entryId];
    const sourceClause = sourceAlbumId ? ' OR album_id = ?' : '';
    [uploads] = await connection.execute(
      `SELECT DISTINCT storage_name FROM album_photos
       WHERE storage_type = 'upload'
         AND (journal_entry_id = ?${sourceClause})
       FOR UPDATE`,
      params,
    );
    await connection.execute(
      `DELETE FROM album_photos
       WHERE journal_entry_id = ?${sourceClause}`,
      params,
    );
    if (sourceAlbumId) {
      await connection.execute(
        'DELETE FROM photo_albums WHERE id = ? AND system_key IS NULL',
        [sourceAlbumId],
      );
    }
    await connection.execute('DELETE FROM journal_entries WHERE id = ?', [entryId]);
    await connection.commit();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const cleanupErrors = await cleanupCommittedUploads(
    uploadDir,
    uploads,
    removeStoredUpload,
  );
  return { cleanupErrors, entryId };
}

function createJournalRouter(config) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    let entries = [];
    let milestones = [];
    let dbError = null;
    if (!isDbAvailable()) {
      dbError = 'Journal moments are temporarily unavailable because the database is offline.';
    } else {
      try {
        let photos;
        [[entries], [photos], [milestones]] = await Promise.all([
          getPool().execute(
            `SELECT j.id, j.title, j.body,
                    DATE_FORMAT(j.entry_date, '%Y-%m-%d') AS entry_date,
                    j.display_order, j.milestone_id, j.source_album_id,
                    m.title AS milestone_title
             FROM journal_entries j
             LEFT JOIN timeline_milestones m ON m.id = j.milestone_id
             ORDER BY j.display_order, j.entry_date DESC, j.id DESC`,
          ),
          getPool().execute(
            `SELECT id, journal_entry_id, caption,
                    DATE_FORMAT(photo_date, '%Y-%m-%d') AS photo_date,
                    display_order
             FROM album_photos
             WHERE journal_entry_id IS NOT NULL
             ORDER BY journal_entry_id, display_order, id`,
          ),
          getPool().execute(
            'SELECT id, title FROM timeline_milestones ORDER BY display_order, id',
          ),
        ]);
        const photosByEntry = new Map();
        photos.forEach((photo) => {
          const id = Number(photo.journal_entry_id);
          if (!photosByEntry.has(id)) photosByEntry.set(id, []);
          photosByEntry.get(id).push(photo);
        });
        entries = entries.map((entry) => ({
          ...entry,
          photos: photosByEntry.get(Number(entry.id)) || [],
        }));
      } catch (error) {
        console.error('Journal load failed:', error.message);
        dbError = 'Journal moments could not be loaded.';
      }
    }
    if (!dbError) res.allowPrivateSnapshot?.();
    return res.render('journal', {
      title: 'Journal & Photos | GBAGL',
      page: 'journal',
      entries,
      milestones,
      dbError,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  router.post('/', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    return withMediaOperation(async () => {
      try {
        const entryId = await createJournalEntry({
          body: req.body,
          databasePool: getPool(),
          file: req.file,
          uploadDir: config.uploadDir,
        });
        return redirectMessage(res, 'message', 'Journal moment added.', entryId);
      } catch (error) {
        console.error('Journal create failed:', error.message);
        return redirectMessage(res, 'error', error.message);
      }
    });
  });

  router.post('/reorder', async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'Database unavailable' });
    try {
      await reorderCollection(getPool(), 'journal', req.body.ids);
      return res.status(204).end();
    } catch (error) {
      console.error('Journal reorder failed:', error.message);
      const publicError = publicOrderError(error);
      return res.status(publicError.status).json({ error: publicError.message });
    }
  });

  router.post('/:id/photos/reorder', async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'Database unavailable' });
    try {
      await reorderCollection(
        getPool(),
        'journalPhotos',
        req.body.ids,
        positiveId(req.params.id),
      );
      return res.status(204).end();
    } catch (error) {
      console.error('Journal photo reorder failed:', error.message);
      const publicError = publicOrderError(error);
      return res.status(publicError.status).json({ error: publicError.message });
    }
  });

  router.post('/:id/photos', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    return withMediaOperation(async () => {
      try {
        const entryId = await addJournalPhoto({
          body: req.body,
          databasePool: getPool(),
          entryId: req.params.id,
          file: req.file,
          uploadDir: config.uploadDir,
        });
        return redirectMessage(res, 'message', 'Photo added.', entryId);
      } catch (error) {
        console.error('Journal photo upload failed:', error.message);
        return redirectMessage(res, 'error', error.message);
      }
    });
  });

  router.post('/:entryId/photos/:photoId', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const entryId = positiveId(req.params.entryId);
      const [result] = await getPool().execute(
        `UPDATE album_photos SET caption = ?
         WHERE id = ? AND journal_entry_id = ?`,
        [
          photoCaption(req.body) || null,
          positiveId(req.params.photoId),
          entryId,
        ],
      );
      if (result.affectedRows !== 1) throw new Error('Photo not found');
      return redirectMessage(res, 'message', 'Photo caption updated.', entryId);
    } catch (error) {
      console.error('Journal photo update failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/:entryId/photos/:photoId/delete', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    return withMediaOperation(async () => {
      try {
        const result = await deleteJournalPhoto({
          databasePool: getPool(),
          entryId: req.params.entryId,
          photoId: req.params.photoId,
          uploadDir: config.uploadDir,
        });
        if (result.cleanupErrors.length) {
          result.cleanupErrors.forEach((error) => console.error(
            'Deleted journal photo cleanup failed:',
            error.message,
          ));
          return redirectMessage(
            res,
            'error',
            'Photo removed, but its orphaned upload file requires cleanup.',
            result.entryId,
          );
        }
        return redirectMessage(res, 'message', 'Photo removed.', result.entryId);
      } catch (error) {
        console.error('Journal photo delete failed:', error.message);
        return redirectMessage(res, 'error', error.message);
      }
    });
  });

  router.post('/:id/delete', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    return withMediaOperation(async () => {
      try {
        const result = await deleteJournalEntry({
          databasePool: getPool(),
          entryId: req.params.id,
          uploadDir: config.uploadDir,
        });
        if (result.cleanupErrors.length) {
          result.cleanupErrors.forEach((error) => console.error(
            'Deleted journal media cleanup failed:',
            error.message,
          ));
          return redirectMessage(
            res,
            'error',
            'Journal moment deleted, but one or more orphaned uploads require cleanup.',
          );
        }
        return redirectMessage(res, 'message', 'Journal moment deleted.');
      } catch (error) {
        console.error('Journal delete failed:', error.message);
        return redirectMessage(res, 'error', error.message);
      }
    });
  });

  router.post('/:id', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const entryId = await updateJournalEntry(getPool(), req.params.id, req.body);
      return redirectMessage(res, 'message', 'Journal moment updated.', entryId);
    } catch (error) {
      console.error('Journal update failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  return router;
}

module.exports = {
  addJournalPhoto,
  createJournalEntry,
  createJournalRouter,
  deleteJournalEntry,
  deleteJournalPhoto,
  insertJournalPhoto,
  updateJournalEntry,
};
