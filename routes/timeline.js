/**
 * routes/timeline.js — Our Timeline page
 */

const express    = require('express');
const router     = express.Router();
const fallbackMilestones = require('../data/timeline');
const {
  TIMELINE_IMPORT_MARKER,
  getPool,
  isDbAvailable,
} = require('../db');

async function loadMilestones({
  databaseAvailable = isDbAvailable,
  databasePool = getPool,
  fallback = fallbackMilestones,
} = {}) {
  if (!databaseAvailable()) return fallback;
  try {
    const pool = databasePool();
    const [rows] = await pool.execute(
      `SELECT id, milestone_date AS date, title, description, emoji, photo, link_url
       FROM timeline_milestones ORDER BY display_order, id`,
    );
    if (rows.length > 0) return rows;

    const [markerRows] = await pool.execute(
      `SELECT setting_value FROM site_settings
       WHERE setting_key = ?`,
      [TIMELINE_IMPORT_MARKER],
    );
    if (markerRows[0]?.setting_value !== 'complete') {
      console.error('Timeline import is incomplete; using file fallback.');
      return fallback;
    }
    return rows;
  } catch (error) {
    console.error('Timeline database load failed; using file fallback:', error.message);
    return fallback;
  }
}

router.get('/', async (req, res) => {
  const milestones = await loadMilestones();
  let journals = [];
  let journalError = null;
  if (!isDbAvailable()) {
    journalError = 'Linked journal entries are unavailable while the database is offline.';
  } else {
    try {
      [journals] = await getPool().execute(
        `SELECT id, milestone_id, title, body,
                DATE_FORMAT(entry_date, '%Y-%m-%d') AS entry_date
         FROM journal_entries WHERE milestone_id IS NOT NULL
         ORDER BY entry_date DESC, id DESC`,
      );
    } catch (error) {
      console.error('Timeline journal load failed:', error.message);
      journalError = 'Linked journal entries could not be loaded.';
    }
  }
  res.render('timeline', {
    title:      'Our Timeline — GBAGL',
    page:       'timeline',
    milestones,
    journals,
    journalError,
  });
});

module.exports = router;
module.exports.loadMilestones = loadMilestones;
