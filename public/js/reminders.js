document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('enableNotifications');
  const status = document.getElementById('notificationStatus');
  if (!button || !status) return;

  if (!('Notification' in window)) {
    button.disabled = true;
    status.textContent = 'This browser does not support notifications.';
    return;
  }

  async function showDueReminders() {
    const response = await fetch('/reminders/feed.json', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Reminder feed unavailable');
    const payload = await response.json();
    const formatReminderTime = window.gbaglReminderFormat?.formatReminderTime;
    payload.reminders.forEach((reminder) => {
      const key = `gbagl-reminder-${reminder.id}-${reminder.reminderAt}`;
      if (localStorage.getItem(key)) return;
      const notification = new Notification(reminder.title, {
        body: `Scheduled for ${
          formatReminderTime
            ? formatReminderTime(reminder.eventAt, payload.timeZone)
            : new Date(reminder.eventAt).toLocaleString()
        }`,
        tag: `gbagl-event-${reminder.id}`,
      });
      notification.addEventListener('click', () => {
        window.focus();
        window.location.assign(reminder.url);
      });
      localStorage.setItem(key, 'shown');
    });
  }

  button.addEventListener('click', async () => {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      status.textContent = 'Browser reminders were not enabled.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Browser reminders are enabled while this site remains open.';
    try {
      await showDueReminders();
    } catch {
      status.textContent = 'Reminders are enabled, but due events could not be loaded.';
    }
    window.setInterval(() => {
      showDueReminders().catch(() => {});
    }, 60000);
  });
});
