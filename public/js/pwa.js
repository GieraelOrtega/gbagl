(function initializePwa() {
  let deferredInstallPrompt = null;

  function installButtons() {
    return document.querySelectorAll('[data-install-app]');
  }

  function setInstallVisible(visible) {
    installButtons().forEach((button) => {
      button.hidden = !visible;
    });
  }

  function clearReminderDedupe() {
    try {
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith('gbagl-reminder-')) localStorage.removeItem(key);
      }
    } catch (error) {
      console.warn('GBAGL reminder state could not be cleared:', error);
    }
  }

  async function clearPrivateData() {
    if ('caches' in window) {
      const names = await window.caches.keys();
      await Promise.all(names
        .filter((name) => name.startsWith('gbagl-private-'))
        .map((name) => window.caches.delete(name)));
    }
    clearReminderDedupe();
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration('/');
    try {
      const notifications = await registration?.getNotifications();
      notifications?.forEach((notification) => notification.close());
    } catch (error) {
      console.warn('GBAGL notifications could not be cleared:', error);
    }
    const worker = navigator.serviceWorker.controller
      || registration?.active
      || registration?.waiting;
    worker?.postMessage({ type: 'CLEAR_PRIVATE_DATA' });
  }

  function updateNetworkStatus() {
    document.querySelectorAll('[data-network-status]').forEach((status) => {
      status.textContent = navigator.onLine ? 'Online' : 'Offline · read-only copies';
      status.classList.toggle('network-status--offline', !navigator.onLine);
    });
    document.querySelectorAll(
      'form[method="post"]:not([action="/lock"]), form[method="POST"]:not([action="/lock"])',
    ).forEach((form) => {
      form.querySelectorAll('button, input, select, textarea').forEach((control) => {
        if (!navigator.onLine && !control.disabled) {
          control.disabled = true;
          control.dataset.offlineDisabled = 'true';
        } else if (navigator.onLine && control.dataset.offlineDisabled === 'true') {
          control.disabled = false;
          delete control.dataset.offlineDisabled;
        }
      });
      form.classList.toggle('offline-disabled', !navigator.onLine);
    });
  }

  async function authorizePrivateCache() {
    if (
      !('serviceWorker' in navigator)
      || document.body.hasAttribute('data-locked-state')
      || document.body.hasAttribute('data-offline-snapshot')
    ) return;
    const registration = await navigator.serviceWorker.getRegistration('/');
    const worker = navigator.serviceWorker.controller
      || registration?.active
      || registration?.waiting;
    worker?.postMessage({
      type: 'AUTHORIZE_PRIVATE_CACHE',
      url: window.location.href,
    });
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    setInstallVisible(true);
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    setInstallVisible(false);
  });
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);

  document.addEventListener('DOMContentLoaded', () => {
    updateNetworkStatus();
    if (document.body.hasAttribute('data-locked-state')) {
      void clearPrivateData().catch((error) => {
        console.error('GBAGL locked-state cleanup failed:', error);
      });
    } else if (!document.body.hasAttribute('data-offline-snapshot')) {
      void authorizePrivateCache().catch((error) => {
        console.error('GBAGL private cache authorization failed:', error);
      });
    }
    installButtons().forEach((button) => {
      button.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        await deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        setInstallVisible(false);
      });
    });
    document.querySelectorAll('form[action="/lock"]').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await clearPrivateData();
        } catch (error) {
          console.error('GBAGL private cache clearing failed:', error);
        }
        HTMLFormElement.prototype.submit.call(form);
      });
    });
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'AUTHORIZATION_LOST') clearReminderDedupe();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
        .then(() => navigator.serviceWorker.ready)
        .then(() => authorizePrivateCache())
        .catch((error) => {
          console.error('GBAGL service worker registration failed:', error);
        });
    });
  }

  window.gbaglPwa = Object.freeze({ clearPrivateData });
}());
