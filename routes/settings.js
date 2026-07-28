const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const { getPool, isDbAvailable } = require('../db');
const { validateSettings } = require('../lib/validation');
const { createExportRouter } = require('./exports');

function redirectMessage(res, type, message) {
  const params = new URLSearchParams({ [type]: message });
  return res.redirect(303, `/settings?${params}`);
}

function createSettingsRouter({
  accountAuth,
  backupService,
  config,
  exportService,
}) {
  const router = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).render('settings-login', {
      title: 'Account sign in | GBAGL',
      page: 'settings',
      error: 'Unable to sign in. Wait a few minutes and try again.',
    }),
  });

  router.get('/login', (req, res) => {
    if (accountAuth.isMember(req)) return res.redirect(303, '/settings');
    return res.render('settings-login', {
      title: 'Account sign in | GBAGL',
      page: 'settings',
      error: null,
    });
  });

  router.post('/login', loginLimiter, (req, res) => {
    const user = accountAuth.authenticate(req.body.username, req.body.password);
    if (!user) {
      return res.status(401).render('settings-login', {
        title: 'Account sign in | GBAGL',
        page: 'settings',
        error: 'Unable to sign in with those credentials.',
      });
    }
    accountAuth.setAccountCookie(res, user);
    return res.redirect(303, '/settings');
  });

  router.use(accountAuth.requireAccount);

  router.post('/logout', (req, res) => {
    accountAuth.clearAccountCookie(res);
    return res.redirect(303, '/');
  });

  router.use(
    '/exports',
    accountAuth.requireAdmin,
    createExportRouter(exportService),
  );
  router.get('/', async (req, res) => {
    let settings = {};
    let backups = [];
    let dbError = null;
    if (isDbAvailable()) {
      try {
        const [settingRows] = await getPool().execute(
          'SELECT setting_key, setting_value FROM site_settings',
        );
        settings = Object.fromEntries(
          settingRows.map((row) => [row.setting_key, row.setting_value]),
        );
      } catch (error) {
        console.error('Settings database load failed:', error.message);
        dbError = 'Database records could not be loaded.';
      }
    } else {
      dbError = 'The database is unavailable.';
    }
    if (accountAuth.isAdmin(req)) {
      try {
        backups = await backupService.list();
      } catch (error) {
        console.error('Backup list failed:', error.message);
      }
    }

    return res.render('settings', {
      title: 'Settings | GBAGL',
      page: 'settings',
      backups,
      dbError,
      settings,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  router.post('/site', accountAuth.requireAdmin, async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const settings = validateSettings(req.body);
      await getPool().query(
        `INSERT INTO site_settings (setting_key, setting_value) VALUES ?
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [Object.entries(settings)],
      );
      return redirectMessage(res, 'message', 'Site settings saved.');
    } catch (error) {
      console.error('Site settings update failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/backups', accountAuth.requireAdmin, async (req, res) => {
    try {
      await backupService.create();
      return redirectMessage(res, 'message', 'Backup created.');
    } catch (error) {
      console.error('Manual backup failed:', error.message);
      return redirectMessage(res, 'error', 'Backup could not be created.');
    }
  });

  router.get('/backups/:filename', accountAuth.requireAdmin, async (req, res) => {
    try {
      const backupPath = backupService.downloadPath(req.params.filename);
      await fs.promises.access(backupPath, fs.constants.R_OK);
      return res.download(backupPath, req.params.filename);
    } catch (error) {
      console.error('Backup download rejected:', error.message);
      return res.status(404).render('error', {
        title: 'Backup not found | GBAGL',
        page: 'settings',
        status: 404,
        message: 'That backup does not exist.',
      });
    }
  });

  return router;
}

module.exports = { createSettingsRouter };
