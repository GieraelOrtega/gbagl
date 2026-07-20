(function initializePwa() {
  let deferredInstallPrompt = null;
  let wasReadOnly = false;

  function installButtons() {
    return document.querySelectorAll('[data-install-app]');
  }

  function updatePwaControls() {
    document.querySelectorAll('[data-pwa-controls]').forEach((controls) => {
      controls.hidden = !controls.querySelector(
        '[data-install-app]:not([hidden]), [data-network-status]:not([hidden])',
      );
    });
  }

  function setInstallVisible(visible) {
    installButtons().forEach((button) => {
      button.hidden = !visible;
    });
    updatePwaControls();
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

  function signalPrivateDataClear() {
    if (!('serviceWorker' in navigator)) return;
    const controller = navigator.serviceWorker.controller;
    if (controller) {
      controller.postMessage({ type: 'CLEAR_PRIVATE_DATA' });
      return;
    }
    void navigator.serviceWorker.getRegistration('/').then((registration) => {
      const worker = registration?.active || registration?.waiting;
      worker?.postMessage({ type: 'CLEAR_PRIVATE_DATA' });
    }).catch((error) => {
      console.warn('GBAGL worker cleanup signal failed:', error);
    });
  }

  async function clearPhysicalPrivateData() {
    const operations = [];
    if ('caches' in window) {
      operations.push((async () => {
        const names = await window.caches.keys();
        await Promise.allSettled(names
          .filter((name) => name.startsWith('gbagl-private-'))
          .map((name) => window.caches.delete(name)));
      })());
    }
    if ('serviceWorker' in navigator) {
      operations.push((async () => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const notifications = await registration?.getNotifications();
        await Promise.allSettled((notifications || []).map(
          (notification) => Promise.resolve().then(() => notification.close()),
        ));
      })());
    }
    await Promise.allSettled(operations);
  }

  function clearPrivateData() {
    clearReminderDedupe();
    signalPrivateDataClear();
    return clearPhysicalPrivateData();
  }

  function updateNetworkStatus() {
    const readOnly = !navigator.onLine
      || document.body.hasAttribute('data-offline-snapshot');
    const message = 'Offline · read-only copies';
    document.querySelectorAll('[data-network-status]').forEach((status) => {
      status.textContent = readOnly ? message : '';
      status.hidden = !readOnly;
      status.classList.toggle('network-status--offline', readOnly);
    });
    document.querySelectorAll('[data-network-status-container]').forEach((container) => {
      container.hidden = !readOnly;
    });
    document.querySelectorAll('[data-network-status-announcer]').forEach((announcer) => {
      announcer.textContent = readOnly ? message : (wasReadOnly ? 'Online' : '');
    });
    wasReadOnly = readOnly;
    updatePwaControls();
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
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        try {
          void clearPrivateData().catch((error) => {
            console.error('GBAGL private cache clearing failed:', error);
          });
        } catch (error) {
          console.error('GBAGL private cache clearing failed:', error);
        } finally {
          HTMLFormElement.prototype.submit.call(form);
        }
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
