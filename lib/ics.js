function escapeIcs(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function utcStamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('Invalid calendar date');
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildEventIcs(event, origin, now = new Date()) {
  const uid = `event-${event.id}@${new URL(origin).hostname}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GBAGL//Shared Event//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeIcs(uid)}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(event.eventAt)}`,
    `SUMMARY:${escapeIcs(event.title)}`,
    `DESCRIPTION:${escapeIcs(event.notes)}`,
  ];
  if (event.reminderAt) {
    const minutes = Math.max(
      0,
      Math.floor((new Date(event.eventAt) - new Date(event.reminderAt)) / 60000),
    );
    lines.push(
      'BEGIN:VALARM',
      `TRIGGER:-PT${minutes}M`,
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcs(event.title)}`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

module.exports = { buildEventIcs, escapeIcs, utcStamp };
