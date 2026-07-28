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
const { createAccountAuth } = require('./middleware/accountAuth');
const { createCsrfProtection } = require('./middleware/csrf');
const { createPasscodeAuth, safeDestination } = require('./middleware/passcode');
const { createBackupService, scheduleBackups } = require('./services/backup');
const { createKeepsakeExportService } = require('./services/keepsakeExport');
const { createImageUploadIngress } = require('./middleware/imageUpload');
const { createIndexRouter } = require('./routes/index');
const { createSettingsRouter } = require('./routes/settings');
const { createAlbumsRouter } = require('./routes/albums');
const { createBucketRouter } = require('./routes/bucket');
const { createJournalRouter } = require('./routes/journal');
const { createRemindersRouter } = require('./routes/reminders');
const {
  PRIVATE_SNAPSHOT_HEADER,
  SNAPSHOT_OPT_IN,
  isPrivateSnapshotPath,
} = require('./public/js/pwaPolicy');

const UNLOCK_ATTEMPT_LIMIT = 5;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

function unlockAttemptState(req) {
  const rateLimitState = req.rateLimit || {};
  const limit = Number(rateLimitState.limit) || UNLOCK_ATTEMPT_LIMIT;
  const used = Math.min(Number(rateLimitState.used) || 1, limit);
  const remaining = Math.max(Number(rateLimitState.remaining) || 0, 0);
  const reset = rateLimitState.resetTime instanceof Date
    ? rateLimitState.resetTime.getTime()
    : Date.now() + UNLOCK_WINDOW_MS;
  return {
    limit,
    used,
    remaining,
    lockoutUntil: remaining === 0 ? reset : null,
  };
}

function unlockStoreAttemptState(client) {
  const used = Number(client?.totalHits);
  const resetTime = client?.resetTime instanceof Date
    ? client.resetTime
    : new Date(client?.resetTime);
  if (
    !Number.isSafeInteger(used)
    || used < 1
    || !Number.isFinite(resetTime.getTime())
    || resetTime.getTime() <= Date.now()
  ) {
    return null;
  }
  return unlockAttemptState({
    rateLimit: {
      limit: UNLOCK_ATTEMPT_LIMIT,
      remaining: Math.max(UNLOCK_ATTEMPT_LIMIT - used, 0),
      resetTime,
      used,
    },
  });
}

function createApp(config = loadConfig(), services = {}) {
  const app = express();
  app.set('trust proxy', config.trustProxy || ['loopback']);
  if (config.production) {
    app.use((req, res, next) => {
      if (req.secure) return next();
      res.set('Cache-Control', 'no-store');
      return res.redirect(308, `${config.publicOrigin}${req.originalUrl}`);
    });
  }

  const accountAuth = createAccountAuth(config);
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
    res.locals.currentUser = null;
    res.locals.canEdit = false;
    res.locals.isAdmin = false;
    res.locals.offlineSnapshot = false;
    res.locals.attempts = null;
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "style-src 'self'",
        "font-src 'self'",
        "img-src 'self' data:",
        "script-src 'self'",
        "connect-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "worker-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    if (config.production) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
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
  app.get('/js/theme.js', publicFile('js/theme.js'));
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
    '/home-photo',
    createImageUploadIngress({
      accountAuth,
      config: uploadConfig,
      errorDestination: '/',
      passcodeAuth,
    }),
  );
  app.use(
    '/albums/photos/upload',
    createImageUploadIngress({
      accountAuth,
      config: uploadConfig,
      errorDestination: '/albums',
      passcodeAuth,
    }),
  );
  app.use(csrfProtection.verify);

  const unlockStore = new rateLimit.MemoryStore();
  const unlockKey = (req) => rateLimit.ipKeyGenerator(req.ip);
  const unlockLimiter = rateLimit({
    windowMs: UNLOCK_WINDOW_MS,
    limit: UNLOCK_ATTEMPT_LIMIT,
    keyGenerator: unlockKey,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: unlockStore,
    handler: (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(429).render('lock', {
        title: 'GBAGL — Locked',
        error: 'Too many incorrect attempts.',
        next: safeDestination(req.body.next),
        attempts: unlockAttemptState(req),
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
        error: 'Incorrect passcode.',
        next: safeDestination(req.body.next),
        attempts: unlockAttemptState(req),
      });
    }
    passcodeAuth.setUnlockCookie(res);
    return res.redirect(303, safeDestination(req.body.next));
  });

  app.use(async (req, res, next) => {
    if (passcodeAuth.isUnlocked(req)) return next();
    try {
      const key = unlockKey(req);
      const client = await unlockStore.get(key);
      const attempts = unlockStoreAttemptState(client);
      if (client && !attempts) await unlockStore.resetKey(key);
      res.locals.attempts = attempts;
      return next();
    } catch (error) {
      return next(error);
    }
  });
  app.use(passcodeAuth.requirePasscode);
  app.use((req, res, next) => {
    const currentUser = accountAuth.currentUser(req);
    res.locals.currentUser = currentUser;
    res.locals.isAdmin = currentUser?.role === 'admin';
    res.locals.canEdit = Boolean(currentUser) && !req.isOfflineSnapshot;
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
    accountAuth.clearAccountCookie(res);
    res.set({
      'Clear-Site-Data': '"cache", "storage"',
      'X-GBAGL-Clear-Private-Data': '1',
    });
    return res.redirect(303, '/');
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/settings', createSettingsRouter({
    accountAuth,
    backupService,
    config: uploadConfig,
    exportService,
  }));
  app.use('/', createIndexRouter(uploadConfig, accountAuth));
  app.use('/adventure', accountAuth.requireMemberWrite, require('./routes/adventure'));
  app.use('/timeline', accountAuth.requireMemberWrite, require('./routes/timeline'));
  app.use('/bucket', accountAuth.requireMemberWrite, createBucketRouter());
  app.use('/reminders', accountAuth.requireMemberWrite, createRemindersRouter());
  app.use('/albums', accountAuth.requireMemberWrite, createAlbumsRouter(uploadConfig));
  app.use('/journal', accountAuth.requireMemberWrite, createJournalRouter());
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
