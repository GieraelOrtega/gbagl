const express = require('express');
const { getPool, isDbAvailable } = require('../db');

function createJournalRouter() {
  const router = express.Router();
  router.get('/', async (req, res) => {
    let entries = [];
    let dbError = null;
    if (!isDbAvailable()) {
      dbError = 'Journal entries are temporarily unavailable because the database is offline.';
    } else {
      try {
        [entries] = await getPool().execute(
          `SELECT j.id, j.title, j.body,
                  DATE_FORMAT(j.entry_date, '%Y-%m-%d') AS entry_date,
                  j.milestone_id, m.title AS milestone_title
           FROM journal_entries j
           LEFT JOIN timeline_milestones m ON m.id = j.milestone_id
           ORDER BY j.entry_date DESC, j.id DESC`,
        );
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
      dbError,
    });
  });
  return router;
}

module.exports = { createJournalRouter };
