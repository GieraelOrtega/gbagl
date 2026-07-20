const test = require('node:test');
const assert = require('node:assert/strict');
const { formatReminderTime } = require('../public/js/reminderFormat');

test('browser reminder formatting uses the feed timezone', () => {
  const eventAt = '2026-07-20T03:30:00Z';
  assert.equal(
    formatReminderTime(eventAt, 'America/Los_Angeles', 'en-US'),
    'Jul 19, 2026, 8:30 PM',
  );
  assert.equal(
    formatReminderTime(eventAt, 'Europe/London', 'en-US'),
    'Jul 20, 2026, 4:30 AM',
  );
});

test('browser reminder formatting safely handles unavailable timezone data', () => {
  assert.doesNotThrow(() => formatReminderTime(
    '2026-07-20T03:30:00Z',
    'Not/A_Timezone',
    'en-US',
  ));
  assert.equal(formatReminderTime('not-a-date', 'UTC', 'en-US'), 'an unknown time');
});
