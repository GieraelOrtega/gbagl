const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const { getPool, isDbAvailable } = require('../db');
const {
  positiveId,
  validateMilestone,
  validateSettings,
} = require('../lib/validation');
const { createSettingsContentRouter } = require('./settingsContent');
const { createExportRouter } = require('./exports');

const VALID_STATUSES = ['pending', 'done', 'favorite'];

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
  router.use('/content', createSettingsContentRouter(config));

  router.get('/', async (req, res) => {
    let settings = {};
    let milestones = [];
    let ideas = [];
    let backups = [];
    let dbError = null;
    if (isDbAvailable()) {
      try {
        const [[settingRows], [milestoneRows], [ideaRows]] = await Promise.all([
          getPool().execute('SELECT setting_key, setting_value FROM site_settings'),
          getPool().execute(
            `SELECT id, display_order, milestone_date AS date, title, description,
                    emoji, photo, link_url
             FROM timeline_milestones ORDER BY display_order, id`,
          ),
          getPool().execute('SELECT * FROM date_ideas ORDER BY created_at DESC'),
        ]);
        settings = Object.fromEntries(
          settingRows.map((row) => [row.setting_key, row.setting_value]),
        );
        milestones = milestoneRows;
        ideas = ideaRows;
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
      ideas,
      milestones,
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

  router.post('/timeline', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const milestone = validateMilestone(req.body);
      await getPool().execute(
        `INSERT INTO timeline_milestones
          (display_order, milestone_date, title, description, emoji, photo, link_url)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          milestone.displayOrder,
          milestone.date,
          milestone.title,
          milestone.description,
          milestone.emoji,
          milestone.photo,
          milestone.linkUrl,
        ],
      );
      return redirectMessage(res, 'message', 'Milestone added.');
    } catch (error) {
      console.error('Milestone create failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/timeline/:id', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const id = positiveId(req.params.id);
      const milestone = validateMilestone(req.body);
      await getPool().execute(
        `UPDATE timeline_milestones
         SET display_order = ?, milestone_date = ?, title = ?, description = ?,
             emoji = ?, photo = ?, link_url = ?
         WHERE id = ?`,
        [
          milestone.displayOrder,
          milestone.date,
          milestone.title,
          milestone.description,
          milestone.emoji,
          milestone.photo,
          milestone.linkUrl,
          id,
        ],
      );
      return redirectMessage(res, 'message', 'Milestone updated.');
    } catch (error) {
      console.error('Milestone update failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/timeline/:id/delete', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      await getPool().execute(
        'DELETE FROM timeline_milestones WHERE id = ?',
        [positiveId(req.params.id)],
      );
      return redirectMessage(res, 'message', 'Milestone deleted.');
    } catch (error) {
      console.error('Milestone delete failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/ideas/:id/status', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const id = positiveId(req.params.id);
      if (!VALID_STATUSES.includes(req.body.status)) throw new Error('Invalid idea status');
      await getPool().execute('UPDATE date_ideas SET status = ? WHERE id = ?', [
        req.body.status,
        id,
      ]);
      return redirectMessage(res, 'message', 'Date idea updated.');
    } catch (error) {
      console.error('Settings idea update failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/ideas/:id/delete', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      await getPool().execute('DELETE FROM date_ideas WHERE id = ?', [
        positiveId(req.params.id),
      ]);
      return redirectMessage(res, 'message', 'Date idea deleted.');
    } catch (error) {
      console.error('Settings idea delete failed:', error.message);
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
