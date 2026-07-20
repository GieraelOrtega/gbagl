/**
 * routes/timeline.js — Our Timeline page
 */

const express    = require('express');
const router     = express.Router();
const fallbackMilestones = require('../data/timeline');
const { getPool, isDbAvailable } = require('../db');

router.get('/', async (req, res) => {
  let milestones = fallbackMilestones;
  if (isDbAvailable()) {
    try {
      const [rows] = await getPool().execute(
        `SELECT milestone_date AS date, title, description, emoji, photo, link_url
         FROM timeline_milestones ORDER BY display_order, id`,
      );
      if (rows.length > 0) milestones = rows;
    } catch (error) {
      console.error('Timeline database load failed; using file fallback:', error.message);
    }
  }
  res.render('timeline', {
    title:      'Our Timeline — GBAGL',
    page:       'timeline',
    milestones,
  });
});

module.exports = router;
