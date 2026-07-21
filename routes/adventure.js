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
const {
  nextDisplayOrder,
  publicOrderError,
  reorderCollection,
} = require('../lib/contentOrder');
const { positiveId, text } = require('../lib/validation');

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

function redirectMessage(res, type, message) {
  return res.redirect(303, `/adventure?${new URLSearchParams({ [type]: message })}`);
}

function validateIdea(body) {
  if (!VALID_VIBES.includes(body.vibe)) throw new Error('Choose a valid vibe');
  if (!VALID_BUDGETS.includes(body.budget)) throw new Error('Choose a valid budget');
  if (!VALID_LOCATIONS.includes(body.location)) throw new Error('Choose a valid setting');
  return {
    vibe: body.vibe,
    budget: body.budget,
    location: body.location,
    notes: text(body.notes, 'Notes', 1000, { required: false }),
  };
}

// ── GET /adventure ─────────────────────────────────────────
router.get('/', readLimiter, async (req, res) => {
  let ideas    = [];
  let dbError  = null;

  if (isDbAvailable()) {
    try {
      const [rows] = await getPool().execute(
        `SELECT *, DATE_FORMAT(created_at, '%b %e, %Y') AS created_at_display
        FROM date_ideas ORDER BY display_order, created_at DESC, id DESC`,
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
    return redirectMessage(res, 'error', 'Database not available right now. Try again soon!');
  }

  try {
    const idea = validateIdea(req.body);
    const displayOrder = await nextDisplayOrder(getPool(), 'adventures');
    await getPool().execute(
      `INSERT INTO date_ideas (vibe, budget, location, notes, display_order)
       VALUES (?, ?, ?, ?, ?)`,
      [idea.vibe, idea.budget, idea.location, idea.notes, displayOrder],
    );
    return redirectMessage(res, 'message', 'Date idea saved!');
  } catch (err) {
    console.error('Error saving idea:', err.message);
    return redirectMessage(res, 'error', err.message);
  }
});

router.post('/reorder', async (req, res) => {
  if (!isDbAvailable()) return res.status(503).json({ error: 'Database unavailable' });
  try {
    await reorderCollection(getPool(), 'adventures', req.body.ids);
    return res.status(204).end();
  } catch (error) {
    console.error('Adventure reorder failed:', error.message);
    const publicError = publicOrderError(error);
    return res.status(publicError.status).json({ error: publicError.message });
  }
});

router.post('/:id', writeLimiter, async (req, res) => {
  if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
  try {
    const idea = validateIdea(req.body);
    const [result] = await getPool().execute(
      `UPDATE date_ideas
       SET vibe = ?, budget = ?, location = ?, notes = ?
       WHERE id = ?`,
      [
        idea.vibe,
        idea.budget,
        idea.location,
        idea.notes,
        positiveId(req.params.id),
      ],
    );
    if (result.affectedRows !== 1) throw new Error('Adventure idea not found');
    return redirectMessage(res, 'message', 'Adventure idea updated.');
  } catch (error) {
    console.error('Adventure update failed:', error.message);
    return redirectMessage(res, 'error', error.message);
  }
});

// ── POST /adventure/:id/delete ─────────────────────────────
router.post('/:id/delete', writeLimiter, async (req, res) => {
  if (!isDbAvailable()) {
    return res.redirect('/adventure?error=Database+not+available.');
  }

  try {
    const id = positiveId(req.params.id);
    await getPool().execute('DELETE FROM date_ideas WHERE id = ?', [id]);
    return redirectMessage(res, 'message', 'Idea removed.');
  } catch (err) {
    console.error('Error deleting idea:', err.message);
    return redirectMessage(res, 'error', 'Could not delete that idea.');
  }
});

// ── POST /adventure/:id/status ─────────────────────────────
router.post('/:id/status', writeLimiter, async (req, res) => {
  if (!isDbAvailable()) {
    return res.redirect('/adventure?error=Database+not+available.');
  }

  try {
    const id = positiveId(req.params.id);
    const status = req.body.status;
    if (!VALID_STATUSES.includes(status)) throw new Error('Invalid idea status');
    await getPool().execute(
      'UPDATE date_ideas SET status = ? WHERE id = ?',
      [status, id],
    );
    return redirectMessage(res, 'message', 'Idea status updated.');
  } catch (err) {
    console.error('Error updating status:', err.message);
    return redirectMessage(res, 'error', 'Could not update status.');
  }
});

module.exports = router;
