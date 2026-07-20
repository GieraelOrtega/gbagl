/**
 * server.js — GBAGL application entry point
 *
 * Starts an Express web server, sets up routing & middleware,
 * and initialises the database connection.
 *
 * Run with:  npm start          (production)
 *            npm run dev        (development — auto-restarts on file changes)
 */

require('dotenv').config(); // Load .env variables before anything else

const express = require('express');
const rateLimit = require('express-rate-limit');
const path    = require('path');
const { initDb } = require('./db');
const {
  isValidPasscode,
  requirePasscode,
  safeDestination,
  setUnlockCookie,
} = require('./middleware/passcode');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── View engine ────────────────────────────────────────────
// EJS lets us embed dynamic data into HTML templates
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

// ── Middleware ─────────────────────────────────────────────
app.use(express.urlencoded({ extended: true })); // Parse HTML form data
app.use(express.json());                          // Parse JSON bodies
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data:",
      "script-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
});

// Lock-screen assets stay public; site content and photos are protected below.
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.get('/js/lock.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/js/lock.js'));
});

const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(429).render('lock', {
      title: 'GBAGL — Locked',
      error: 'Too many attempts. Please wait 15 minutes and try again.',
      next: safeDestination(req.body.next),
    });
  },
});

app.post('/unlock', unlockLimiter, (req, res) => {
  if (!isValidPasscode(req.body.passcode)) {
    res.set('Cache-Control', 'no-store');
    return res.status(401).render('lock', {
      title: 'GBAGL — Locked',
      error: 'Incorrect passcode. Try again.',
      next: safeDestination(req.body.next),
    });
  }

  setUnlockCookie(res);
  return res.redirect(303, safeDestination(req.body.next));
});

app.use(requirePasscode);
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ─────────────────────────────────────────────────
app.use('/',          require('./routes/index'));
app.use('/adventure', require('./routes/adventure'));
app.use('/timeline',  require('./routes/timeline'));

// ── 404 handler ────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('404', {
    title: '404 — Page Not Found | GBAGL',
    page: '',
  });
});

// ── Start everything up ────────────────────────────────────
async function start() {
  await initDb(); // Try to connect to DB (won't crash if unavailable)
  app.listen(PORT, () => {
    console.log(`\n💕  GBAGL is live at http://localhost:${PORT}`);
    console.log(`    Press Ctrl+C to stop.\n`);
  });
}

start();
