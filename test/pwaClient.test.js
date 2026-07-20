const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createClientHarness(deleteImpl, { offlineSnapshot = false, onLine = true } = {}) {
  const documentListeners = new Map();
  const formListeners = new Map();
  const windowListeners = new Map();
  const messages = [];
  const storage = new Map([['gbagl-reminder-7', 'seen']]);
  let submissions = 0;
  const statusClasses = new Set();
  const status = {
    classList: {
      toggle(name, enabled) {
        if (enabled) statusClasses.add(name);
        else statusClasses.delete(name);
      },
    },
    hidden: true,
    textContent: '',
  };
  const statusContainer = { hidden: true };
  const announcer = { textContent: '' };
  const form = {
    addEventListener(type, listener) {
      formListeners.set(type, listener);
    },
  };
  const document = {
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    body: {
      hasAttribute(attribute) {
        return attribute === 'data-offline-snapshot' && offlineSnapshot;
      },
    },
    querySelectorAll(selector) {
      if (selector === 'form[action="/lock"]') return [form];
      if (selector === '[data-network-status]') return [status];
      if (selector === '[data-network-status-container]') return [statusContainer];
      if (selector === '[data-network-status-announcer]') return [announcer];
      return [];
    },
  };
  const localStorage = {
    get length() {
      return storage.size;
    },
    key(index) {
      return [...storage.keys()][index] ?? null;
    },
    removeItem(key) {
      storage.delete(key);
    },
  };
  const serviceWorker = {
    addEventListener() {},
    controller: {
      postMessage(message) {
        messages.push(message);
      },
    },
    getRegistration: async () => ({
      getNotifications: async () => [],
    }),
    ready: Promise.resolve(),
    register: async () => ({}),
  };
  const window = {
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    caches: {
      keys: async () => ['gbagl-private-v1-test'],
      delete: deleteImpl,
    },
    location: { href: 'https://gba.gl/' },
  };
  const navigator = { onLine, serviceWorker };
  const context = vm.createContext({
    console: { error() {}, warn() {} },
    document,
    HTMLFormElement: function HTMLFormElement() {},
    localStorage,
    navigator,
    Promise,
    window,
  });
  context.HTMLFormElement.prototype.submit = () => {
    submissions += 1;
  };
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'pwa.js'),
    'utf8',
  );
  vm.runInContext(source, context);
  documentListeners.get('DOMContentLoaded')();
  return {
    lockSubmit: formListeners.get('submit'),
    messages,
    navigator,
    announcer,
    status,
    statusClasses,
    statusContainer,
    storage,
    submissions: () => submissions,
    updateNetworkStatus: () => windowListeners.get(navigator.onLine ? 'online' : 'offline')(),
  };
}

test('Lock Now submits and signals revocation without waiting for hanging cache deletion', () => {
  const deletion = deferred();
  const harness = createClientHarness(() => deletion.promise);
  let prevented = false;

  harness.lockSubmit({ preventDefault: () => { prevented = true; } });

  assert.equal(prevented, true);
  assert.equal(harness.messages[0].type, 'CLEAR_PRIVATE_DATA');
  assert.equal(harness.storage.has('gbagl-reminder-7'), false);
  assert.equal(harness.submissions(), 1);
  deletion.resolve(true);
});

test('Lock Now submission is not blocked when cache deletion rejects', async () => {
  const harness = createClientHarness(async () => {
    throw new Error('disk failure');
  });
  let prevented = false;

  harness.lockSubmit({ preventDefault: () => { prevented = true; } });
  await Promise.resolve();

  assert.equal(prevented, true);
  assert.equal(harness.messages[0].type, 'CLEAR_PRIVATE_DATA');
  assert.equal(harness.storage.has('gbagl-reminder-7'), false);
  assert.equal(harness.submissions(), 1);
});

test('network status is visible only while offline and announces transitions', () => {
  const harness = createClientHarness(async () => true);

  assert.equal(harness.status.hidden, true);
  assert.equal(harness.statusContainer.hidden, true);
  assert.equal(harness.status.textContent, '');
  assert.equal(harness.announcer.textContent, '');

  harness.navigator.onLine = false;
  harness.updateNetworkStatus();
  assert.equal(harness.status.hidden, false);
  assert.equal(harness.statusContainer.hidden, false);
  assert.equal(harness.status.textContent, 'Offline · read-only copies');
  assert.equal(harness.statusClasses.has('network-status--offline'), true);
  assert.equal(harness.announcer.textContent, 'Offline · read-only copies');

  harness.navigator.onLine = true;
  harness.updateNetworkStatus();
  assert.equal(harness.status.hidden, true);
  assert.equal(harness.statusContainer.hidden, true);
  assert.equal(harness.announcer.textContent, 'Online');
});

test('offline snapshot warning stays visible when browser connectivity returns', () => {
  const harness = createClientHarness(
    async () => true,
    { offlineSnapshot: true, onLine: true },
  );

  assert.equal(harness.status.hidden, false);
  assert.equal(harness.statusContainer.hidden, false);
  assert.equal(harness.status.textContent, 'Offline · read-only copies');
  assert.equal(harness.announcer.textContent, 'Offline · read-only copies');
});
