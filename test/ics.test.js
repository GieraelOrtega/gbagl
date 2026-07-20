const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEventIcs, escapeIcs } = require('../lib/ics');

test('ICS text escapes reserved characters and folds reminder data into a calendar event', () => {
  assert.equal(escapeIcs('one,two;three\\four\nfive'), 'one\\,two\\;three\\\\four\\nfive');
  const ics = buildEventIcs({
    id: 12,
    title: 'Dinner, then dancing',
    notes: 'Bring flowers;\nleave early',
    eventAt: new Date('2026-08-01T03:00:00Z'),
    reminderAt: new Date('2026-08-01T02:30:00Z'),
  }, 'https://gba.gl', new Date('2026-07-19T00:00:00Z'));
  assert.match(ics, /\r\nDTSTART:20260801T030000Z\r\n/);
  assert.match(ics, /SUMMARY:Dinner\\, then dancing/);
  assert.match(ics, /DESCRIPTION:Bring flowers\\;\\nleave early/);
  assert.match(ics, /TRIGGER:-PT30M/);
  assert.match(ics, /UID:event-12@gba\.gl/);
});
