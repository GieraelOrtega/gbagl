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
const path    = require('path');
const { initDb } = require('./db');
const requireUnlocked = require('./middleware/requireUnlocked');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── View engine ────────────────────────────────────────────
// EJS lets us embed dynamic data into HTML templates
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Middleware ─────────────────────────────────────────────
app.use(express.urlencoded({ extended: true })); // Parse HTML form data
app.use(express.json());                          // Parse JSON bodies
app.use(express.static(path.join(__dirname, 'public'))); // Serve CSS/JS/images

// ── Routes ─────────────────────────────────────────────────
app.use('/', require('./routes/gate'));

app.use(requireUnlocked);
app.use('/home',      require('./routes/index'));
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
