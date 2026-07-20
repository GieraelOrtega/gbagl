/**
 * routes/index.js — Landing page
 */

const express = require('express');
const { getPool, isDbAvailable } = require('../db');
const { nextAnniversary } = require('../lib/dates');
const { formatDateTime } = require('../lib/presentation');
const router  = express.Router();

router.get('/', async (req, res) => {
  let settings = {};
  let countdown = null;
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
  res.render('index', {
    title: 'GBAGL — Gunna Be a Great Life',
    page:  'home',
    settings,
    countdown,
    upcomingEvents,
    bucketProgress,
    formatDateTime,
    dbError,
  });
});

module.exports = router;
