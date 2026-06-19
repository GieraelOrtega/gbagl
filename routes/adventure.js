/**
 * routes/adventure.js — Adventure / Date Planner
 *
 * Handles:
 *   GET  /adventure          → show form + saved ideas
 *   POST /adventure          → save a new idea to the DB
 *   POST /adventure/:id/delete → delete a saved idea
 *   POST /adventure/:id/status → toggle an idea's status
 */

const express        = require('express');
const rateLimit      = require('express-rate-limit');
const router         = express.Router();
const { getPool, isDbAvailable } = require('../db');

// ── Rate limiting ──────────────────────────────────────────
// Prevents spamming the DB-backed endpoints.
// 60 read requests per minute, 20 write requests per minute.
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests — slow down and enjoy the moment! 💕',
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests — slow down and enjoy the moment! 💕',
});

// ── Inspiration ideas (always shown; not stored in DB) ─────
// These give the page life even before any ideas are saved.
const suggestedIdeas = [
  {
    vibe:     'cozy',
    budget:   '$',
    location: 'at home',
    notes:    "Movie marathon night with homemade popcorn, blankets, and all your favourites 🍿",
  },
  {
    vibe:     'foodie',
    budget:   '$$',
    location: 'out on the town',
    notes:    "Try that new restaurant you've both been curious about 🍽️",
  },
  {
    vibe:     'adventurous',
    budget:   '$',
    location: 'outdoors',
    notes:    'Sunrise hike followed by a picnic breakfast — beat the crowds and catch that golden light 🌅',
  },
  {
    vibe:     'artsy',
    budget:   '$',
    location: 'indoors',
    notes:    "Paint & sip night — grab a couple of canvases, some wine, and see who's the better artist 🎨",
  },
  {
    vibe:     'chill',
    budget:   'free',
    location: 'outdoors',
    notes:    'Stargazing in the park with blankets, hot cocoa, and zero Wi-Fi ⭐',
  },
];

// ── Valid option sets (used for server-side validation) ────
const VALID_VIBES     = ['cozy', 'adventurous', 'foodie', 'artsy', 'chill'];
const VALID_BUDGETS   = ['free', '$', '$$', '$$$'];
const VALID_LOCATIONS = ['at home', 'indoors', 'outdoors', 'out on the town'];
const VALID_STATUSES  = ['pending', 'done', 'favorite'];

// ── GET /adventure ─────────────────────────────────────────
router.get('/', readLimiter, async (req, res) => {
  let ideas    = [];
  let dbError  = null;

  if (isDbAvailable()) {
    try {
      const [rows] = await getPool().execute(
        'SELECT * FROM date_ideas ORDER BY created_at DESC',
      );
      ideas = rows;
    } catch (err) {
      console.error('Error fetching ideas:', err.message);
      dbError = 'Could not load saved ideas right now. Try again in a moment! 🌸';
    }
  } else {
    dbError =
      "The adventure planner is currently offline — the database isn't connected yet. " +
      'Check your .env settings and restart the server. 💭';
  }

  res.render('adventure', {
    title:          'Adventure Planner — GBAGL',
    page:           'adventure',
    ideas,
    suggestedIdeas,
    dbError,
    message:        req.query.message || null,
    error:          req.query.error   || null,
    validVibes:     VALID_VIBES,
    validBudgets:   VALID_BUDGETS,
    validLocations: VALID_LOCATIONS,
  });
});

// ── POST /adventure (create) ───────────────────────────────
router.post('/', writeLimiter, async (req, res) => {
  if (!isDbAvailable()) {
    return res.redirect(
      '/adventure?error=Database+not+available+right+now.+Try+again+soon!',
    );
  }

  const { vibe, budget, location, notes } = req.body;

  // Validate all selection fields against the whitelist
  if (
    !VALID_VIBES.includes(vibe) ||
    !VALID_BUDGETS.includes(budget) ||
    !VALID_LOCATIONS.includes(location)
  ) {
    return res.redirect('/adventure?error=Invalid+form+values.+Please+try+again.');
  }

  // Sanitise the free-text notes field (strip leading/trailing whitespace)
  const safeNotes = typeof notes === 'string' ? notes.trim().slice(0, 1000) : '';

  try {
    await getPool().execute(
      'INSERT INTO date_ideas (vibe, budget, location, notes) VALUES (?, ?, ?, ?)',
      [vibe, budget, location, safeNotes],
    );
    res.redirect('/adventure?message=Date+idea+saved!+%F0%9F%92%95');
  } catch (err) {
    console.error('Error saving idea:', err.message);
    res.redirect('/adventure?error=Could+not+save+your+idea.+Try+again!');
  }
});

// ── POST /adventure/:id/delete ─────────────────────────────
router.post('/:id/delete', writeLimiter, async (req, res) => {
  if (!isDbAvailable()) {
    return res.redirect('/adventure?error=Database+not+available.');
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) return res.redirect('/adventure');

  try {
    await getPool().execute('DELETE FROM date_ideas WHERE id = ?', [id]);
    res.redirect('/adventure?message=Idea+removed.');
  } catch (err) {
    console.error('Error deleting idea:', err.message);
    res.redirect('/adventure?error=Could+not+delete+that+idea.');
  }
});

// ── POST /adventure/:id/status ─────────────────────────────
router.post('/:id/status', writeLimiter, async (req, res) => {
  if (!isDbAvailable()) {
    return res.redirect('/adventure?error=Database+not+available.');
  }

  const id     = parseInt(req.params.id, 10);
  const status = req.body.status;

  if (isNaN(id) || id <= 0 || !VALID_STATUSES.includes(status)) {
    return res.redirect('/adventure');
  }

  try {
    await getPool().execute(
      'UPDATE date_ideas SET status = ? WHERE id = ?',
      [status, id],
    );
    res.redirect('/adventure');
  } catch (err) {
    console.error('Error updating status:', err.message);
    res.redirect('/adventure?error=Could+not+update+status.');
  }
});

module.exports = router;
