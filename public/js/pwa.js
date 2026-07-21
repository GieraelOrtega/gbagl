(function initializePwa() {
  let deferredInstallPrompt = null;

  function installButtons() {
    return document.querySelectorAll('[data-install-app]');
  }

  function privateMediaUrls() {
    return Array.from(document.querySelectorAll('[data-private-media]'))
      .map((element) => element.currentSrc || element.src)
      .filter(Boolean);
  }

  function isInstalled() {
    return window.matchMedia?.('(display-mode: standalone)')?.matches
      || navigator.standalone === true;
  }

  function setInstallVisible(visible) {
    installButtons().forEach((button) => {
      button.hidden = !visible;
    });
    document.querySelectorAll('[data-pwa-controls]').forEach((controls) => {
      controls.hidden = !visible;
    });
  }

  function installInstructions() {
    const userAgent = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const isIpad = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    if (/iPhone|iPad|iPod/.test(userAgent) || isIpad) {
      return 'On iPhone or iPad: tap Share, then choose Add to Home Screen.';
    }
    if (/Mac/.test(platform) || /Macintosh/.test(userAgent)) {
      return 'On Mac: in Safari choose File > Add to Dock. In Chrome or Edge, use Install in the address bar or browser menu.';
    }
    if (/Win/.test(platform) || /Windows/.test(userAgent)) {
      return 'On Windows: in Edge or Chrome, choose Install in the address bar or browser menu.';
    }
    return 'Open your browser menu and choose Install app or Add to Home Screen.';
  }

  function showInstallHelp() {
    document.querySelectorAll('[data-install-help]').forEach((help) => {
      help.textContent = installInstructions();
      help.hidden = false;
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
      announcer.textContent = readOnly ? message : '';
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
      mediaUrls: privateMediaUrls(),
      type: 'AUTHORIZE_PRIVATE_CACHE',
      url: window.location.href,
    });
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    setInstallVisible(false);
  });
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);

  document.addEventListener('DOMContentLoaded', () => {
    updateNetworkStatus();
    setInstallVisible(!isInstalled());
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
        if (!deferredInstallPrompt) {
          showInstallHelp();
          return;
        }
        await deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if (choice.outcome !== 'accepted') showInstallHelp();
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
