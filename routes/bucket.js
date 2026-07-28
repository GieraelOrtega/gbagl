const express = require('express');
const { getPool, isDbAvailable } = require('../db');
const {
  nextDisplayOrder,
  publicOrderError,
  reorderCollection,
} = require('../lib/contentOrder');
const { localDateValue } = require('../lib/dates');
const { formatDate } = require('../lib/presentation');
const { positiveId } = require('../lib/validation');
const {
  validateBucketCompletion,
  validateBucketItem,
  validateBucketMemory,
  validateVote,
} = require('../lib/hubValidation');
const { toggleVote } = require('../repositories/bucket');

function redirectMessage(res, type, message) {
  return res.redirect(303, `/bucket?${new URLSearchParams({ [type]: message })}`);
}

function createBucketRouter({
  currentDate = () => new Date(),
  databaseAvailable = isDbAvailable,
  databasePool = getPool,
} = {}) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    let activeItems = [];
    let completedItems = [];
    let labels = { partner_one: 'Partner One', partner_two: 'Partner Two' };
    let today = localDateValue(currentDate(), 'UTC');
    let dbError = null;
    if (!databaseAvailable()) {
      dbError = 'The bucket list is temporarily unavailable because the database is offline.';
    } else {
      try {
        const pool = databasePool();
        const [[rows], [settings]] = await Promise.all([
          pool.execute(
            `SELECT i.id, i.title, i.description, i.category,
                    DATE_FORMAT(i.target_date, '%Y-%m-%d') AS target_date,
                    i.display_order,
                    i.is_favorite,
                    DATE_FORMAT(i.completed_at, '%Y-%m-%d') AS completed_at,
                    i.memory,
                    MAX(CASE WHEN v.voter_slot = 'partner_one' THEN v.vote END)
                      AS partner_one_vote,
                    MAX(CASE WHEN v.voter_slot = 'partner_two' THEN v.vote END)
                      AS partner_two_vote
             FROM bucket_items i
             LEFT JOIN bucket_votes v ON v.item_id = i.id
             GROUP BY i.id
             ORDER BY i.completed_at IS NOT NULL,
                      CASE WHEN i.completed_at IS NULL THEN i.display_order END,
                      CASE WHEN i.completed_at IS NULL THEN i.is_favorite END DESC,
                      CASE WHEN i.completed_at IS NULL THEN i.target_date IS NULL END,
                      CASE WHEN i.completed_at IS NULL THEN i.target_date END,
                      CASE WHEN i.completed_at IS NOT NULL THEN i.completed_at END DESC,
                      CASE WHEN i.completed_at IS NOT NULL THEN i.display_order END,
                      i.id DESC`,
          ),
          pool.execute(
            `SELECT setting_key, setting_value FROM site_settings
             WHERE setting_key IN ('partner_one_name', 'partner_two_name', 'timezone')`,
          ),
        ]);
        activeItems = rows.filter((item) => !item.completed_at);
        completedItems = rows.filter((item) => item.completed_at);
        const values = Object.fromEntries(
          settings.map((row) => [row.setting_key, row.setting_value]),
        );
        labels = {
          partner_one: values.partner_one_name || labels.partner_one,
          partner_two: values.partner_two_name || labels.partner_two,
        };
        today = localDateValue(currentDate(), values.timezone || 'UTC');
      } catch (error) {
        console.error('Bucket list load failed:', error.message);
        dbError = 'The bucket list could not be loaded.';
      }
    }
    if (!dbError) res.allowPrivateSnapshot?.();
    return res.render('bucket', {
      title: 'Our Bucket List | GBAGL',
      page: 'bucket',
      activeItems,
      completedItems,
      formatDate,
      labels,
      today,
      dbError,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  router.post('/', async (req, res) => {
    if (!databaseAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const pool = databasePool();
      const item = validateBucketItem(req.body);
      const displayOrder = await nextDisplayOrder(pool, 'bucket');
      await pool.execute(
        `INSERT INTO bucket_items
          (title, description, category, target_date, display_order)
         VALUES (?, ?, ?, ?, ?)`,
        [
          item.title,
          item.description,
          item.category,
          item.targetDate,
          displayOrder,
        ],
      );
      return redirectMessage(res, 'message', 'Bucket List item added.');
    } catch (error) {
      console.error('Bucket item create failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/reorder', async (req, res) => {
    if (!databaseAvailable()) return res.status(503).json({ error: 'Database unavailable' });
    try {
      await reorderCollection(databasePool(), 'bucketActive', req.body.ids);
      return res.status(204).end();
    } catch (error) {
      console.error('Bucket reorder failed:', error.message);
      const publicError = publicOrderError(error);
      return res.status(publicError.status).json({ error: publicError.message });
    }
  });

  router.post('/:id', async (req, res) => {
    if (!databaseAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const item = validateBucketItem(req.body);
      const [result] = await databasePool().execute(
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
      return redirectMessage(res, 'message', 'Bucket List item updated.');
    } catch (error) {
      console.error('Bucket item update failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/:id/delete', async (req, res) => {
    if (!databaseAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const [result] = await databasePool().execute(
        'DELETE FROM bucket_items WHERE id = ?',
        [positiveId(req.params.id)],
      );
      if (result.affectedRows !== 1) throw new Error('Bucket item not found');
      return redirectMessage(res, 'message', 'Bucket List item deleted.');
    } catch (error) {
      console.error('Bucket item delete failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/:id/vote', async (req, res) => {
    if (!databaseAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const id = positiveId(req.params.id);
      const { voterSlot, vote } = validateVote(req.body);
      await toggleVote(databasePool(), id, voterSlot, vote);
      return redirectMessage(res, 'message', 'Vote updated.');
    } catch (error) {
      console.error('Bucket vote failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/:id/favorite', async (req, res) => {
    if (!databaseAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const [result] = await databasePool().execute(
        'UPDATE bucket_items SET is_favorite = NOT is_favorite WHERE id = ?',
        [positiveId(req.params.id)],
      );
      if (result.affectedRows !== 1) throw new Error('Bucket item not found');
      return redirectMessage(res, 'message', 'Favorite updated.');
    } catch (error) {
      console.error('Bucket favorite failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/:id/completion', async (req, res) => {
    if (!databaseAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const id = positiveId(req.params.id);
      const completedAt = validateBucketCompletion(req.body);
      const [result] = await databasePool().execute(
        'UPDATE bucket_items SET completed_at = ? WHERE id = ?',
        [completedAt, id],
      );
      if (result.affectedRows !== 1) throw new Error('Bucket item not found');
      return redirectMessage(res, 'message', completedAt ? 'Marked complete.' : 'Item reopened.');
    } catch (error) {
      console.error('Bucket completion failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/:id/memory', async (req, res) => {
    if (!databaseAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const memory = validateBucketMemory(req.body);
      const [result] = await databasePool().execute(
        `UPDATE bucket_items SET memory = ?
         WHERE id = ? AND completed_at IS NOT NULL`,
        [memory || null, positiveId(req.params.id)],
      );
      if (result.affectedRows !== 1) {
        throw new Error('Complete the bucket item before adding a memory');
      }
      return redirectMessage(res, 'message', 'Memory saved.');
    } catch (error) {
      console.error('Bucket memory failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  return router;
}

module.exports = { createBucketRouter };
