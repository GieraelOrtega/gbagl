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

function createClientHarness(deleteImpl, {
  displayStandalone = false,
  maxTouchPoints = 0,
  offlineSnapshot = false,
  onLine = true,
  platform = '',
  standalone = false,
  userAgent = '',
} = {}) {
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
  const installListeners = new Map();
  const installButton = {
    hidden: false,
    addEventListener(type, listener) {
      installListeners.set(type, listener);
    },
  };
  const installHelp = { hidden: true, textContent: '' };
  const pwaControls = { hidden: false };
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
      if (selector === '[data-install-app]') return [installButton];
      if (selector === '[data-install-help]') return [installHelp];
      if (selector === '[data-pwa-controls]') return [pwaControls];
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
    matchMedia: () => ({ matches: displayStandalone }),
  };
  const navigator = {
    maxTouchPoints,
    onLine,
    platform,
    serviceWorker,
    standalone,
    userAgent,
  };
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
    clickInstall: () => installListeners.get('click')(),
    dispatchWindow: (type, event) => windowListeners.get(type)(event),
    installButton,
    installHelp,
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

test('network status is visible only while offline and never announces Online text', () => {
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
  assert.equal(harness.announcer.textContent, '');
});

test('Install Now stays visible and gives iPhone, iPad, Mac, and Windows guidance', async (t) => {
  const platforms = [
    {
      name: 'iPhone',
      options: { platform: 'iPhone', userAgent: 'iPhone' },
      expected: /iPhone or iPad.*Share.*Add to Home Screen/,
    },
    {
      name: 'iPad',
      options: { platform: 'MacIntel', maxTouchPoints: 5, userAgent: 'Macintosh' },
      expected: /iPhone or iPad.*Share.*Add to Home Screen/,
    },
    {
      name: 'Mac',
      options: { platform: 'MacIntel', userAgent: 'Macintosh' },
      expected: /On Mac.*Add to Dock.*Chrome or Edge/,
    },
    {
      name: 'Windows',
      options: { platform: 'Win32', userAgent: 'Windows NT 10.0' },
      expected: /On Windows.*Edge or Chrome/,
    },
  ];

  for (const platform of platforms) {
    await t.test(platform.name, async () => {
      const harness = createClientHarness(async () => true, platform.options);
      assert.equal(harness.installButton.hidden, false);
      await harness.clickInstall();
      assert.equal(harness.installHelp.hidden, false);
      assert.match(harness.installHelp.textContent, platform.expected);
    });
  }
});

test('Install Now uses the native browser prompt when one is available', async () => {
  const harness = createClientHarness(async () => true);
  let prevented = false;
  let prompted = false;
  harness.dispatchWindow('beforeinstallprompt', {
    preventDefault: () => { prevented = true; },
    prompt: async () => { prompted = true; },
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  });

  await harness.clickInstall();

  assert.equal(prevented, true);
  assert.equal(prompted, true);
  assert.equal(harness.installHelp.hidden, true);
});

test('install controls hide when GBAGL is already running standalone', () => {
  const harness = createClientHarness(
    async () => true,
    { displayStandalone: true },
  );
  assert.equal(harness.installButton.hidden, true);
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
