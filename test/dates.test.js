const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nextAnniversary,
  zonedLocalToUtc,
} = require('../lib/dates');
const { formatDate } = require('../lib/presentation');

test('next anniversary preserves leap day and uses February 28 in other years', () => {
  const ordinaryYear = nextAnniversary(
    '2020-02-29',
    'UTC',
    new Date('2025-02-27T12:00:00Z'),
  );
  assert.equal(ordinaryYear.date.toISOString(), '2025-02-28T00:00:00.000Z');
  assert.equal(ordinaryYear.year, 2025);

  const leapYear = nextAnniversary(
    '2020-02-29',
    'UTC',
    new Date('2028-02-28T12:00:00Z'),
  );
  assert.equal(leapYear.date.toISOString(), '2028-02-29T00:00:00.000Z');
  assert.equal(leapYear.year, 2028);
});

test('anniversary countdown uses the configured timezone and unset dates stay unset', () => {
  const countdown = nextAnniversary(
    '2020-07-19',
    'America/Los_Angeles',
    new Date('2026-07-19T06:30:00Z'),
  );
  assert.equal(countdown.date.toISOString(), '2026-07-19T07:00:00.000Z');
  assert.equal(countdown.days, 1);
  const anniversaryDay = nextAnniversary(
    '2020-07-19',
    'America/Los_Angeles',
    new Date('2026-07-19T16:00:00Z'),
  );
  assert.equal(anniversaryDay.year, 2026);
  assert.equal(anniversaryDay.days, 0);
  assert.equal(nextAnniversary('', 'UTC'), null);
});

test('anniversary countdown uses the first valid instant when DST skips local midnight', () => {
  const countdown = nextAnniversary(
    '2020-09-06',
    'America/Santiago',
    new Date('2026-07-20T04:00:00Z'),
  );
  assert.equal(countdown.date.toISOString(), '2026-09-06T04:00:00.000Z');
  assert.equal(countdown.year, 2026);
});

test('local event times convert to UTC and reject skipped daylight-saving times', () => {
  assert.equal(
    zonedLocalToUtc('2026-07-19T20:30', 'America/Los_Angeles').toISOString(),
    '2026-07-20T03:30:00.000Z',
  );
  assert.throws(
    () => zonedLocalToUtc('2026-03-08T02:30', 'America/Los_Angeles'),
    /does not exist/,
  );
});

test('anniversary dates render without timezone day shifts', () => {
  assert.equal(formatDate('2025-12-08'), 'December 8, 2025');
  assert.equal(formatDate('not-a-date'), '');
});
