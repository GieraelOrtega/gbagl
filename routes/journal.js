const express = require('express');
const { getPool, isDbAvailable } = require('../db');
const {
  nextDisplayOrder,
  publicOrderError,
  reorderCollection,
} = require('../lib/contentOrder');
const { validateJournal } = require('../lib/hubValidation');
const { positiveId } = require('../lib/validation');

function redirectMessage(res, type, message) {
  return res.redirect(303, `/journal?${new URLSearchParams({ [type]: message })}`);
}

function createJournalRouter() {
  const router = express.Router();
  router.get('/', async (req, res) => {
    let entries = [];
    let milestones = [];
    let dbError = null;
    if (!isDbAvailable()) {
      dbError = 'Journal entries are temporarily unavailable because the database is offline.';
    } else {
      try {
        [[entries], [milestones]] = await Promise.all([
          getPool().execute(
            `SELECT j.id, j.title, j.body,
                    DATE_FORMAT(j.entry_date, '%Y-%m-%d') AS entry_date,
                    j.display_order, j.milestone_id, m.title AS milestone_title
             FROM journal_entries j
             LEFT JOIN timeline_milestones m ON m.id = j.milestone_id
             ORDER BY j.display_order, j.entry_date DESC, j.id DESC`,
          ),
          getPool().execute(
            'SELECT id, title FROM timeline_milestones ORDER BY display_order, id',
          ),
        ]);
      } catch (error) {
        console.error('Journal load failed:', error.message);
        dbError = 'Journal entries could not be loaded.';
      }
    }
    if (!dbError) res.allowPrivateSnapshot?.();
    return res.render('journal', {
      title: 'Shared Journal | GBAGL',
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
    try {
      const entry = validateJournal(req.body);
      const displayOrder = await nextDisplayOrder(getPool(), 'journal');
      await getPool().execute(
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
      return redirectMessage(res, 'message', 'Journal entry added.');
    } catch (error) {
      console.error('Journal create failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
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

  router.post('/:id', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
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
      return redirectMessage(res, 'message', 'Journal entry updated.');
    } catch (error) {
      console.error('Journal update failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/:id/delete', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const [result] = await getPool().execute(
        'DELETE FROM journal_entries WHERE id = ?',
        [positiveId(req.params.id)],
      );
      if (result.affectedRows !== 1) throw new Error('Journal entry not found');
      return redirectMessage(res, 'message', 'Journal entry deleted.');
    } catch (error) {
      console.error('Journal delete failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  return router;
}

module.exports = { createJournalRouter };
