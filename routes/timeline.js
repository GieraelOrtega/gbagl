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
const {
  nextDisplayOrder,
  publicOrderError,
  reorderCollection,
} = require('../lib/contentOrder');
const { positiveId, validateMilestone } = require('../lib/validation');

function redirectMessage(res, type, message, id = null) {
  const query = new URLSearchParams({ [type]: message, edit: '1' });
  const hash = id ? `#milestone-${id}` : '';
  return res.redirect(303, `/timeline?${query}${hash}`);
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
              photo, link_url
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

router.get('/', async (req, res) => {
  const {
    milestones,
    degraded: timelineDegraded,
  } = await loadMilestonesResult();
  let journals = [];
  let journalError = null;
  if (!isDbAvailable()) {
    journalError = 'Linked journal entries are unavailable while the database is offline.';
  } else {
    try {
      [journals] = await getPool().execute(
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
    title:      'Our Timeline — GBAGL',
    page:       'timeline',
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
  if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
  try {
    const milestone = validateMilestone(req.body);
    const displayOrder = await nextDisplayOrder(getPool(), 'timeline');
    const [result] = await getPool().execute(
      `INSERT INTO timeline_milestones
        (display_order, milestone_date, title, description, emoji, photo, link_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        displayOrder,
        milestone.date,
        milestone.title,
        milestone.description,
        milestone.emoji,
        milestone.photo,
        milestone.linkUrl,
      ],
    );
    return redirectMessage(res, 'message', 'Milestone added.', result.insertId);
  } catch (error) {
    console.error('Milestone create failed:', error.message);
    return redirectMessage(res, 'error', error.message);
  }
});

router.post('/reorder', async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Database unavailable' });
  try {
    await reorderCollection(getPool(), 'timeline', req.body.ids);
    return res.status(204).end();
  } catch (error) {
    console.error('Timeline reorder failed:', error.message);
    const publicError = publicOrderError(error);
    return res.status(publicError.status).json({ error: publicError.message });
  }
});

router.post('/:id', async (req, res) => {
  if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
  try {
    const id = positiveId(req.params.id);
    const milestone = validateMilestone(req.body);
    const [result] = await getPool().execute(
      `UPDATE timeline_milestones
       SET milestone_date = ?, title = ?, description = ?, emoji = ?, photo = ?,
           link_url = ?
       WHERE id = ?`,
      [
        milestone.date,
        milestone.title,
        milestone.description,
        milestone.emoji,
        milestone.photo,
        milestone.linkUrl,
        id,
      ],
    );
    if (result.affectedRows !== 1) throw new Error('Milestone not found');
    return redirectMessage(res, 'message', 'Milestone updated.', id);
  } catch (error) {
    console.error('Milestone update failed:', error.message);
    return redirectMessage(res, 'error', error.message);
  }
});

router.post('/:id/delete', async (req, res) => {
  if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
  try {
    const [result] = await getPool().execute(
      'DELETE FROM timeline_milestones WHERE id = ?',
      [positiveId(req.params.id)],
    );
    if (result.affectedRows !== 1) throw new Error('Milestone not found');
    return redirectMessage(res, 'message', 'Milestone deleted.');
  } catch (error) {
    console.error('Milestone delete failed:', error.message);
    return redirectMessage(res, 'error', error.message);
  }
});

module.exports = router;
module.exports.loadMilestones = loadMilestones;
module.exports.loadMilestonesResult = loadMilestonesResult;
