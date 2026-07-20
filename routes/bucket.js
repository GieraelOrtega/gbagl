const express = require('express');
const { getPool, isDbAvailable } = require('../db');
const { positiveId } = require('../lib/validation');
const {
  validateBucketMemory,
  validateVote,
} = require('../lib/hubValidation');
const { toggleVote } = require('../repositories/bucket');

function redirectMessage(res, type, message) {
  return res.redirect(303, `/bucket?${new URLSearchParams({ [type]: message })}`);
}

function createBucketRouter() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    let items = [];
    let labels = { partner_one: 'Partner One', partner_two: 'Partner Two' };
    let dbError = null;
    if (!isDbAvailable()) {
      dbError = 'The bucket list is temporarily unavailable because the database is offline.';
    } else {
      try {
        const [[rows], [settings]] = await Promise.all([
          getPool().execute(
            `SELECT i.id, i.title, i.description, i.category,
                    DATE_FORMAT(i.target_date, '%Y-%m-%d') AS target_date,
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
             ORDER BY i.completed_at IS NOT NULL, i.is_favorite DESC,
                      i.target_date IS NULL, i.target_date, i.id DESC`,
          ),
          getPool().execute(
            `SELECT setting_key, setting_value FROM site_settings
             WHERE setting_key IN ('partner_one_name', 'partner_two_name')`,
          ),
        ]);
        items = rows;
        const values = Object.fromEntries(
          settings.map((row) => [row.setting_key, row.setting_value]),
        );
        labels = {
          partner_one: values.partner_one_name || labels.partner_one,
          partner_two: values.partner_two_name || labels.partner_two,
        };
      } catch (error) {
        console.error('Bucket list load failed:', error.message);
        dbError = 'The bucket list could not be loaded.';
      }
    }
    return res.render('bucket', {
      title: 'Our Bucket List | GBAGL',
      page: 'bucket',
      items,
      labels,
      dbError,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  router.post('/:id/vote', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const id = positiveId(req.params.id);
      const { voterSlot, vote } = validateVote(req.body);
      await toggleVote(getPool(), id, voterSlot, vote);
      return redirectMessage(res, 'message', 'Vote updated.');
    } catch (error) {
      console.error('Bucket vote failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/:id/favorite', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const [result] = await getPool().execute(
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
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const id = positiveId(req.params.id);
      const completedAt = req.body.completed === '1'
        ? require('../lib/validation').isoDate(req.body.completed_at, 'Completion date')
        : null;
      const [result] = await getPool().execute(
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
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const memory = validateBucketMemory(req.body);
      const [result] = await getPool().execute(
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
