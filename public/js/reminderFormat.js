(function exposeReminderFormat(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.gbaglReminderFormat = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  function formatReminderTime(value, timeZone, locale = 'en-US') {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return 'an unknown time';
    try {
      return new Intl.DateTimeFormat(locale, {
        timeZone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
    } catch {
      return new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
    }
  }

  return { formatReminderTime };
}));
