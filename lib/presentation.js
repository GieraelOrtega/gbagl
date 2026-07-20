const { zonedParts } = require('./dates');

function parseUtc(value) {
  if (value instanceof Date) return value;
  const normalized = String(value).replace(' ', 'T');
  return new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
}

function formatDateTime(value, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parseUtc(value));
}

function localInputValue(value, timeZone) {
  if (!value) return '';
  const parts = zonedParts(parseUtc(value), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

module.exports = { formatDateTime, localInputValue, parseUtc };
