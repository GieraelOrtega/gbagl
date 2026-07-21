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
    for (const reminder of payload.reminders) {
      const key = `gbagl-reminder-${reminder.id}-${reminder.reminderAt}`;
      if (localStorage.getItem(key)) continue;
      const options = {
        body: `Scheduled for ${
          formatReminderTime
            ? formatReminderTime(reminder.eventAt, payload.timeZone)
            : new Date(reminder.eventAt).toLocaleString()
        }`,
        tag: `gbagl-event-${reminder.id}`,
        data: { url: reminder.url },
        icon: '/icons/icon-192.png?v=gk-ux-1',
      };
      const show = async () => {
        const registration = 'serviceWorker' in navigator
          ? await navigator.serviceWorker.ready.catch(() => null)
          : null;
        if (!registration) throw new Error('Service worker unavailable');
        await registration.showNotification(reminder.title, options);
      };
      await show();
      localStorage.setItem(key, 'shown');
    }
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
