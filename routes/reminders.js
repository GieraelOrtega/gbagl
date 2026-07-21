const express = require('express');
const { getPool, isDbAvailable } = require('../db');
const {
  nextDisplayOrder,
  publicOrderError,
  reorderCollection,
} = require('../lib/contentOrder');
const { mysqlUtc, zonedLocalToUtc } = require('../lib/dates');
const { validateEvent } = require('../lib/hubValidation');
const { buildEventIcs } = require('../lib/ics');
const { formatDateTime, localInputValue, parseUtc } = require('../lib/presentation');
const { positiveId } = require('../lib/validation');

const EVENT_SELECT = `
  SELECT id, title,
         DATE_FORMAT(event_at, '%Y-%m-%dT%H:%i:%sZ') AS event_at,
         DATE_FORMAT(reminder_at, '%Y-%m-%dT%H:%i:%sZ') AS reminder_at,
         notes, display_order, is_completed, reminder_dismissed
  FROM shared_events`;

async function loadTimezone() {
  const [rows] = await getPool().execute(
    "SELECT setting_value FROM site_settings WHERE setting_key = 'timezone'",
  );
  return rows[0]?.setting_value || 'UTC';
}

function redirectMessage(res, type, message) {
  return res.redirect(303, `/reminders?${new URLSearchParams({ [type]: message })}`);
}

async function eventValues(body) {
  const event = validateEvent(body);
  const timeZone = await loadTimezone();
  return {
    ...event,
    eventAt: mysqlUtc(zonedLocalToUtc(event.eventAt, timeZone)),
    reminderAt: event.reminderAt
      ? mysqlUtc(zonedLocalToUtc(event.reminderAt, timeZone))
      : null,
  };
}

function createRemindersRouter() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    let upcoming = [];
    let past = [];
    let timeZone = 'UTC';
    let dbError = null;
    if (!isDbAvailable()) {
      dbError = 'Events are temporarily unavailable because the database is offline.';
    } else {
      try {
        const [[upcomingRows], [pastRows], zone] = await Promise.all([
          getPool().execute(
            `${EVENT_SELECT} WHERE event_at >= UTC_TIMESTAMP()
            ORDER BY display_order, event_at, id`,
          ),
          getPool().execute(
            `${EVENT_SELECT} WHERE event_at < UTC_TIMESTAMP()
            ORDER BY display_order, event_at DESC, id DESC`,
          ),
          loadTimezone(),
        ]);
        timeZone = zone;
        const withInputs = (event) => ({
          ...event,
          event_input: localInputValue(event.event_at, timeZone),
          reminder_input: localInputValue(event.reminder_at, timeZone),
        });
        upcoming = upcomingRows.map(withInputs);
        past = pastRows.map(withInputs);
      } catch (error) {
        console.error('Reminder page load failed:', error.message);
        dbError = 'Events could not be loaded.';
      }
    }
    if (!dbError) res.allowPrivateSnapshot?.();
    return res.render('reminders', {
      title: 'Events & Reminders | GBAGL',
      page: 'reminders',
      upcoming,
      past,
      timeZone,
      formatDateTime,
      dbError,
      message: req.query.message || null,
      error: req.query.error || null,
    });
  });

  router.post('/', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const event = await eventValues(req.body);
      const displayOrder = await nextDisplayOrder(getPool(), 'events');
      await getPool().execute(
        `INSERT INTO shared_events
          (title, event_at, reminder_at, notes, display_order, is_completed)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          event.title,
          event.eventAt,
          event.reminderAt,
          event.notes || null,
          displayOrder,
          event.isCompleted,
        ],
      );
      return redirectMessage(res, 'message', 'Event added.');
    } catch (error) {
      console.error('Event create failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/reorder', async (req, res) => {
    if (!isDbAvailable()) return res.status(503).json({ error: 'Database unavailable' });
    try {
      await reorderCollection(getPool(), 'events', req.body.ids);
      return res.status(204).end();
    } catch (error) {
      console.error('Event reorder failed:', error.message);
      const publicError = publicOrderError(error);
      return res.status(publicError.status).json({ error: publicError.message });
    }
  });

  router.post('/:id', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const event = await eventValues(req.body);
      const [result] = await getPool().execute(
        `UPDATE shared_events
         SET title = ?, event_at = ?, reminder_at = ?, notes = ?,
             is_completed = ?, reminder_dismissed = FALSE
         WHERE id = ?`,
        [
          event.title,
          event.eventAt,
          event.reminderAt,
          event.notes || null,
          event.isCompleted,
          positiveId(req.params.id),
        ],
      );
      if (result.affectedRows !== 1) throw new Error('Event not found');
      return redirectMessage(res, 'message', 'Event updated.');
    } catch (error) {
      console.error('Event update failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.post('/:id/delete', async (req, res) => {
    if (!isDbAvailable()) return redirectMessage(res, 'error', 'Database unavailable.');
    try {
      const [result] = await getPool().execute(
        'DELETE FROM shared_events WHERE id = ?',
        [positiveId(req.params.id)],
      );
      if (result.affectedRows !== 1) throw new Error('Event not found');
      return redirectMessage(res, 'message', 'Event deleted.');
    } catch (error) {
      console.error('Event delete failed:', error.message);
      return redirectMessage(res, 'error', error.message);
    }
  });

  router.get('/feed.json', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isDbAvailable()) {
      return res.status(503).json({ error: 'Reminders are unavailable' });
    }
    try {
      const [[rows], timeZone] = await Promise.all([
        getPool().execute(
          `${EVENT_SELECT}
           WHERE reminder_at IS NOT NULL
             AND reminder_dismissed = FALSE
             AND is_completed = FALSE
             AND reminder_at <= UTC_TIMESTAMP()
             AND event_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)
           ORDER BY reminder_at
           LIMIT 25`,
        ),
        loadTimezone(),
      ]);
      return res.json({
        timeZone,
        reminders: rows.map((row) => ({
          id: row.id,
          title: row.title,
          eventAt: row.event_at,
          reminderAt: row.reminder_at,
          url: `/reminders#event-${row.id}`,
        })),
      });
    } catch (error) {
      console.error('Reminder feed failed:', error.message);
      return res.status(500).json({ error: 'Reminders could not be loaded' });
    }
  });

  router.post('/:id/dismiss', async (req, res) => {
    if (!isDbAvailable()) {
      return res.redirect(303, '/reminders?error=Database+unavailable.');
    }
    try {
      const [result] = await getPool().execute(
        `UPDATE shared_events SET reminder_dismissed = TRUE
         WHERE id = ? AND reminder_at IS NOT NULL`,
        [positiveId(req.params.id)],
      );
      if (result.affectedRows !== 1) throw new Error('Reminder not found');
      return res.redirect(303, '/reminders');
    } catch (error) {
      console.error('Reminder dismiss failed:', error.message);
      return res.redirect(
        303,
        `/reminders?${new URLSearchParams({ error: error.message })}`,
      );
    }
  });

  router.get('/:id.ics', async (req, res) => {
    if (!isDbAvailable()) {
      return res.status(503).render('error', {
        title: 'Calendar unavailable | GBAGL',
        page: 'reminders',
        status: 503,
        message: 'The database is unavailable.',
      });
    }
    try {
      const [rows] = await getPool().execute(
        `${EVENT_SELECT} WHERE id = ?`,
        [positiveId(req.params.id)],
      );
      if (!rows[0]) throw new Error('Event not found');
      const event = {
        id: rows[0].id,
        title: rows[0].title,
        notes: rows[0].notes,
        eventAt: parseUtc(rows[0].event_at),
        reminderAt: rows[0].reminder_at ? parseUtc(rows[0].reminder_at) : null,
      };
      const origin = `${req.protocol}://${req.get('host')}`;
      res.set({
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="gbagl-event-${event.id}.ics"`,
        'Cache-Control': 'private, no-store',
      });
      return res.send(buildEventIcs(event, origin));
    } catch (error) {
      console.error('ICS download failed:', error.message);
      return res.status(404).render('error', {
        title: 'Event not found | GBAGL',
        page: 'reminders',
        status: 404,
        message: 'That event does not exist.',
      });
    }
  });

  return router;
}

module.exports = { EVENT_SELECT, createRemindersRouter, loadTimezone };
