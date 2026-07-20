function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function anniversaryDay(year, month, day) {
  if (month === 2 && day === 29 && !isLeapYear(year)) return { month: 2, day: 28 };
  return { month, day };
}

function zonedLocalToUtc(localValue, timeZone) {
  const match = String(localValue).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) throw new Error('Invalid local date and time');
  const desired = match.slice(1).map(Number);
  const targetAsUtc = Date.UTC(
    desired[0],
    desired[1] - 1,
    desired[2],
    desired[3],
    desired[4],
    desired[5] || 0,
  );
  let guess = new Date(targetAsUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(guess, timeZone);
    const actualAsUtc = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      Number(actual.minute),
      Number(actual.second),
    );
    guess = new Date(guess.valueOf() + (targetAsUtc - actualAsUtc));
  }
  const verified = zonedParts(guess, timeZone);
  const values = [
    verified.year,
    verified.month,
    verified.day,
    verified.hour,
    verified.minute,
  ].map(Number);
  if (values.some((value, index) => value !== desired[index])) {
    throw new Error('That local time does not exist in the configured timezone');
  }
  return guess;
}

function mysqlUtc(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function nextAnniversary(anniversaryDate, timeZone, now = new Date()) {
  if (!anniversaryDate) return null;
  const match = anniversaryDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const current = zonedParts(now, timeZone);
  let year = Number(current.year);
  let adjusted = anniversaryDay(year, month, day);
  let next = zonedLocalToUtc(
    `${year}-${String(adjusted.month).padStart(2, '0')}-${String(adjusted.day).padStart(2, '0')}T00:00`,
    timeZone,
  );
  const currentMonth = Number(current.month);
  const currentDay = Number(current.day);
  if (
    adjusted.month < currentMonth
    || (adjusted.month === currentMonth && adjusted.day < currentDay)
  ) {
    year += 1;
    adjusted = anniversaryDay(year, month, day);
    next = zonedLocalToUtc(
      `${year}-${String(adjusted.month).padStart(2, '0')}-${String(adjusted.day).padStart(2, '0')}T00:00`,
      timeZone,
    );
  }
  const remainingMs = Math.max(0, next.valueOf() - now.valueOf());
  return {
    date: next,
    days: Math.ceil(remainingMs / 86400000),
    remainingMs,
    year,
  };
}

module.exports = {
  isLeapYear,
  mysqlUtc,
  nextAnniversary,
  zonedLocalToUtc,
  zonedParts,
};
