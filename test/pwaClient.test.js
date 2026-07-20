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

function createClientHarness(deleteImpl) {
  const documentListeners = new Map();
  const formListeners = new Map();
  const messages = [];
  const storage = new Map([['gbagl-reminder-7', 'seen']]);
  let submissions = 0;
  const form = {
    addEventListener(type, listener) {
      formListeners.set(type, listener);
    },
  };
  const document = {
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    body: { hasAttribute: () => false },
    querySelectorAll(selector) {
      return selector === 'form[action="/lock"]' ? [form] : [];
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
    addEventListener() {},
    caches: {
      keys: async () => ['gbagl-private-v1-test'],
      delete: deleteImpl,
    },
    location: { href: 'https://gba.gl/' },
  };
  const context = vm.createContext({
    console: { error() {}, warn() {} },
    document,
    HTMLFormElement: function HTMLFormElement() {},
    localStorage,
    navigator: { onLine: true, serviceWorker },
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
    storage,
    submissions: () => submissions,
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
