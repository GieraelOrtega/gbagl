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
const { loadConfig } = require('./config');
const { createAdminAuth } = require('./middleware/adminAuth');
const { createCsrfProtection } = require('./middleware/csrf');
const { createPasscodeAuth, safeDestination } = require('./middleware/passcode');
const { createBackupService, scheduleBackups } = require('./services/backup');
const { createKeepsakeExportService } = require('./services/keepsakeExport');
const { createAdminRouter } = require('./routes/admin');
const { createAdminHubRouter, createUploadIngress } = require('./routes/adminHub');
const { createAlbumsRouter } = require('./routes/albums');
const { createBucketRouter } = require('./routes/bucket');
const { createJournalRouter } = require('./routes/journal');
const { createRemindersRouter } = require('./routes/reminders');
const {
  PRIVATE_SNAPSHOT_HEADER,
  SNAPSHOT_OPT_IN,
  isPrivateSnapshotPath,
} = require('./public/js/pwaPolicy');

function createApp(config = loadConfig(), services = {}) {
  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  const adminAuth = createAdminAuth(config);
  const passcodeAuth = createPasscodeAuth(config);
  const backupService = services.backupService || createBackupService(config);
  const uploadConfig = {
    ...config,
    uploadDir: config.uploadDir || path.join(__dirname, 'runtime', 'uploads'),
    uploadMaxBytes: config.uploadMaxBytes || 8 * 1024 * 1024,
  };
  const exportService = services.exportService
    || createKeepsakeExportService(uploadConfig);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.isAdmin = false;
    res.locals.offlineSnapshot = false;
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self' data:",
        "script-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    next();
  });
  const publicFile = (relativePath, headers = {}) => (req, res) => {
    res.set(headers);
    res.sendFile(path.join(__dirname, 'public', relativePath));
  };
  app.get('/css/style.css', publicFile('css/style.css'));
  app.get('/js/lock.js', publicFile('js/lock.js'));
  app.get('/js/pwa.js', publicFile('js/pwa.js'));
  app.get('/js/pwaPolicy.js', publicFile('js/pwaPolicy.js'));
  app.get('/manifest.webmanifest', publicFile('manifest.webmanifest', {
    'Content-Type': 'application/manifest+json',
  }));
  app.get('/service-worker.js', publicFile('service-worker.js', {
    'Cache-Control': 'no-cache',
    'Service-Worker-Allowed': '/',
  }));
  app.get('/offline.html', publicFile('offline.html'));
  app.get('/icons/icon-192.png', publicFile('icons/icon-192.png'));
  app.get('/icons/icon-512.png', publicFile('icons/icon-512.png'));
  const csrfProtection = createCsrfProtection({
    secret: config.cookieSecret,
    secure: config.production,
  });
  app.use((req, res, next) => {
    req.isOfflineSnapshot = req.method === 'GET'
      && req.get('X-GBAGL-Offline-Snapshot') === '1'
      && isPrivateSnapshotPath(req.path)
      && passcodeAuth.isUnlocked(req);
    if (req.isOfflineSnapshot) {
      res.locals.csrfToken = null;
      return next();
    }
    return csrfProtection.initialize(req, res, next);
  });
  app.use(
    '/admin/albums/photos/upload',
    createUploadIngress(uploadConfig, adminAuth, passcodeAuth),
  );
  app.use(csrfProtection.verify);

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
    if (!passcodeAuth.isValidPasscode(req.body.passcode)) {
      res.set({
        'Cache-Control': 'no-store',
        'X-GBAGL-Authorization-Lost': '1',
      });
      return res.status(401).render('lock', {
        title: 'GBAGL — Locked',
        error: 'Incorrect passcode. Try again.',
        next: safeDestination(req.body.next),
      });
    }
    passcodeAuth.setUnlockCookie(res);
    return res.redirect(303, safeDestination(req.body.next));
  });

  app.use(passcodeAuth.requirePasscode);
  app.use((req, res, next) => {
    res.locals.isAdmin = adminAuth.isAdmin(req);
    if (
      req.isOfflineSnapshot
    ) {
      res.locals.offlineSnapshot = true;
      res.set('Vary', 'X-GBAGL-Offline-Snapshot');
      res.allowPrivateSnapshot = () => res.set(
        PRIVATE_SNAPSHOT_HEADER,
        SNAPSHOT_OPT_IN,
      );
    }
    next();
  });
  app.post('/lock', (req, res) => {
    passcodeAuth.clearUnlockCookie(res);
    adminAuth.clearAdminCookie(res);
    res.set({
      'Clear-Site-Data': '"cache", "storage"',
      'X-GBAGL-Clear-Private-Data': '1',
    });
    return res.redirect(303, '/');
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/admin', createAdminRouter({
    adminAuth,
    backupService,
    config: uploadConfig,
    exportService,
  }));
  app.use('/', require('./routes/index'));
  app.use('/adventure', require('./routes/adventure'));
  app.use('/timeline', require('./routes/timeline'));
  app.use('/bucket', createBucketRouter());
  app.use('/reminders', createRemindersRouter());
  app.use('/albums', createAlbumsRouter(uploadConfig));
  app.use('/journal', createJournalRouter());
  app.use((req, res) => {
    res.status(404).render('404', {
      title: '404 — Page Not Found | GBAGL',
      page: '',
    });
  });
  return { app, backupService };
}

async function start() {
  const config = loadConfig();
  const { app, backupService } = createApp(config);
  await initDb();
  scheduleBackups(backupService, config.backupIntervalHours);
  return app.listen(config.port, () => {
    console.log(`\nGBAGL is live at http://localhost:${config.port}`);
    console.log('Press Ctrl+C to stop.\n');
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createApp, start };
