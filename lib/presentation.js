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

function formatDate(value) {
  const date = new Date(`${String(value)}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    dateStyle: 'long',
  }).format(date);
}

function localInputValue(value, timeZone) {
  if (!value) return '';
  const parts = zonedParts(parseUtc(value), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

module.exports = {
  formatDate,
  formatDateTime,
  localInputValue,
  parseUtc,
};
