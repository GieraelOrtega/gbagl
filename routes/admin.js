const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const { getPool, isDbAvailable } = require('../db');
const {
  positiveId,
  validateMilestone,
  validateSettings,
} = require('../lib/validation');
const { createAdminHubRouter } = require('./adminHub');

const VALID_STATUSES = ['pending', 'done', 'favorite'];

function redirectMessage(res, type, message) {
  const params = new URLSearchParams({ [type]: message });
  return res.redirect(303, `/admin?${params}`);
}

function createAdminRouter({ adminAuth, backupService, config }) {
  const router = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).render('admin-login', {
      title: 'Admin Login | GBAGL',
      page: 'admin',
      error: 'Unable to sign in. Wait a few minutes and try again.',
    }),
  });

  router.get('/login', (req, res) => {
    if (adminAuth.isAdmin(req)) return res.redirect(303, '/admin');
    return res.render('admin-login', {
      title: 'Admin Login | GBAGL',
      page: 'admin',
      error: null,
    });
  });

  router.post('/login', loginLimiter, (req, res) => {
    if (!adminAuth.isValidPassword(req.body.password)) {
      return res.status(401).render('admin-login', {
        title: 'Admin Login | GBAGL',
        page: 'admin',
        error: 'Unable to sign in with those credentials.',
      });
    }
    adminAuth.setAdminCookie(res);
    return res.redirect(303, '/admin');
  });

  router.use(adminAuth.requireAdmin);

  router.post('/logout', (req, res) => {
    adminAuth.clearAdminCookie(res);
    return res.redirect(303, '/admin/login');
  });

  router.use(createAdminHubRouter(config));

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
        console.error('Admin database load failed:', error.message);
        dbError = 'Database records could not be loaded.';
      }
    } else {
      dbError = 'The database is unavailable.';
    }
    try {
      backups = await backupService.list();
    } catch (error) {
      console.error('Backup list failed:', error.message);
    }

    return res.render('admin', {
      title: 'Admin Dashboard | GBAGL',
      page: 'admin',
      backups,
      dbError,
      ideas,
      milestones,
      settings,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  router.post('/settings', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const settings = validateSettings(req.body);
      await getPool().query(
        `INSERT INTO site_settings (setting_key, setting_value) VALUES ?
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [Object.entries(settings)],
      );
      return redirectMessage(res, 'message', 'Settings saved.');
    } catch (error) {
      console.error('Settings update failed:', error.message);
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
    try {
      const id = positiveId(req.params.id);
      if (!VALID_STATUSES.includes(req.body.status)) throw new Error('Invalid idea status');
      await getPool().execute('UPDATE date_ideas SET status = ? WHERE id = ?', [
        req.body.status,
        id,
      ]);
      return redirectMessage(res, 'message', 'Date idea updated.');
    } catch (error) {
      console.error('Admin idea update failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/ideas/:id/delete', async (req, res) => {
    try {
      await getPool().execute('DELETE FROM date_ideas WHERE id = ?', [
        positiveId(req.params.id),
      ]);
      return redirectMessage(res, 'message', 'Date idea deleted.');
    } catch (error) {
      console.error('Admin idea delete failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/backups', async (req, res) => {
    try {
      await backupService.create();
      return redirectMessage(res, 'message', 'Backup created.');
    } catch (error) {
      console.error('Manual backup failed:', error.message);
      return redirectMessage(res, 'error', 'Backup could not be created.');
    }
  });

  router.get('/backups/:filename', async (req, res) => {
    try {
      const backupPath = backupService.downloadPath(req.params.filename);
      await fs.promises.access(backupPath, fs.constants.R_OK);
      return res.download(backupPath, req.params.filename);
    } catch (error) {
      console.error('Backup download rejected:', error.message);
      return res.status(404).render('error', {
        title: 'Backup Not Found | GBAGL',
        page: 'admin',
        status: 404,
        message: 'That backup does not exist.',
      });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
