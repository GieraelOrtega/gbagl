const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const policy = require('../public/js/pwaPolicy');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function response(body, {
  cacheOptIn,
  contentType = 'text/html; charset=utf-8',
  status = 200,
} = {}) {
  const headers = new Headers({ 'Content-Type': contentType });
  if (cacheOptIn) headers.set(policy.PRIVATE_SNAPSHOT_HEADER, cacheOptIn);
  if (status === 401 || status === 403) {
    headers.set('X-GBAGL-Authorization-Lost', '1');
  }
  return new Response(body, { headers, status });
}

function createWorkerHarness() {
  const cacheData = new Map([['gbagl-public-v1', new Map([
    ['/offline.html', response('safe offline shell', { status: 503 })],
  ])]]);
  const state = {
    deleteImpl: async (name) => cacheData.delete(name),
    fetchImpl: async () => { throw new Error('offline'); },
    privateMatchCalls: 0,
  };

  function cacheKey(request) {
    return typeof request === 'string' ? request : request.url;
  }

  const caches = {
    async delete(name) {
      return state.deleteImpl(name);
    },
    async keys() {
      return [...cacheData.keys()];
    },
    async match(request, options = {}) {
      if (options.cacheName?.startsWith('gbagl-private-v1-')) {
        state.privateMatchCalls += 1;
      }
      return cacheData.get(options.cacheName)?.get(cacheKey(request))?.clone();
    },
    async open(name) {
      if (!cacheData.has(name)) cacheData.set(name, new Map());
      const entries = cacheData.get(name);
      return {
        async addAll() {},
        async put(request, value) {
          entries.set(cacheKey(request), value.clone());
        },
      };
    },
  };
  const listeners = new Map();
  const self = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    clients: {
      claim: async () => {},
      matchAll: async () => [],
    },
    location: { origin: 'https://gba.gl' },
    crypto: { randomUUID: () => 'worker-test' },
    registration: { getNotifications: async () => [] },
    skipWaiting: async () => {},
  };
  const context = vm.createContext({
    Headers,
    Promise,
    Request,
    Response,
    URL,
    caches,
    console: {
      error() {},
      warn() {},
    },
    fetch: (...args) => state.fetchImpl(...args),
    importScripts() {
      self.gbaglPwaPolicy = policy;
    },
    self,
  });
  const workerSource = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'service-worker.js'),
    'utf8',
  );
  vm.runInContext(`${workerSource}
    self.__testHooks = {
      authorizePrivateCache,
      mutationResponse,
      navigationResponse,
      protectedMediaResponse,
      revokePrivateData,
      state: () => ({
        accessAllowed: privateAccessAllowed,
        cacheName: activePrivateCache,
        generation: privateGeneration,
        lockRequestsPending,
      }),
    };`, context);

  return {
    cacheData,
    hooks: self.__testHooks,
    state,
  };
}

async function authorize(harness, body = 'private snapshot') {
  harness.state.fetchImpl = async () => response(body, {
    cacheOptIn: policy.SNAPSHOT_OPT_IN,
  });
  await harness.hooks.authorizePrivateCache('https://gba.gl/');
  assert.equal(harness.hooks.state().accessAllowed, true);
}

async function offlineNavigation(harness) {
  harness.state.fetchImpl = async () => { throw new Error('offline'); };
  return harness.hooks.navigationResponse(new Request('https://gba.gl/'));
}

test('401 with failed deletion returns auth response and never private fallback', async () => {
  const harness = createWorkerHarness();
  await authorize(harness);
  harness.state.deleteImpl = async () => { throw new Error('disk failure'); };
  harness.state.fetchImpl = async () => response('locked', { status: 401 });

  const authResponse = await harness.hooks.navigationResponse(
    new Request('https://gba.gl/'),
  );
  assert.equal(authResponse.status, 401);
  assert.equal(await authResponse.text(), 'locked');
  assert.equal(harness.hooks.state().accessAllowed, false);

  const offline = await offlineNavigation(harness);
  assert.equal(offline.status, 503);
  assert.equal(await offline.text(), 'safe offline shell');
});

test('offline navigation cannot read private cache while purge is pending', async () => {
  const harness = createWorkerHarness();
  await authorize(harness);
  const deletion = deferred();
  harness.state.deleteImpl = async () => deletion.promise;

  const purge = harness.hooks.revokePrivateData();
  const navigation = offlineNavigation(harness);
  let navigationResolved = false;
  void navigation.then(() => { navigationResolved = true; });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.hooks.state().accessAllowed, false);
  assert.equal(navigationResolved, false);
  assert.equal(harness.state.privateMatchCalls, 0);

  deletion.resolve(true);
  await purge;
  const offline = await navigation;
  assert.equal(await offline.text(), 'safe offline shell');
  assert.equal(harness.state.privateMatchCalls, 0);

});

test('Lock Now revokes synchronously while its purge and response are pending', async () => {
  const harness = createWorkerHarness();
  await authorize(harness);
  const deletion = deferred();
  const lockResponse = deferred();
  const cleanup = [];
  harness.state.deleteImpl = async () => deletion.promise;
  harness.state.fetchImpl = async (request) => {
    if (request.method === 'POST') return lockResponse.promise;
    if (request.headers.get('X-GBAGL-Offline-Snapshot') === '1') {
      return response('racing snapshot', { cacheOptIn: policy.SNAPSHOT_OPT_IN });
    }
    throw new Error('offline');
  };
  const lockUrl = new URL('https://gba.gl/lock');
  const lock = harness.hooks.mutationResponse(
    new Request(lockUrl, { method: 'POST' }),
    lockUrl,
    (promise) => cleanup.push(promise),
  );
  const racingAuthorization = harness.hooks.authorizePrivateCache('https://gba.gl/');
  const navigation = harness.hooks.navigationResponse(new Request('https://gba.gl/'));
  let navigationResolved = false;
  void navigation.then(() => { navigationResolved = true; });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.hooks.state().accessAllowed, false);
  assert.equal(harness.hooks.state().lockRequestsPending, 1);
  assert.equal(navigationResolved, false);
  assert.equal(harness.state.privateMatchCalls, 0);

  deletion.resolve(true);
  await racingAuthorization;
  assert.equal(harness.hooks.state().accessAllowed, false);
  const offline = await navigation;
  assert.equal(await offline.text(), 'safe offline shell');
  lockResponse.resolve(new Response(null, {
    headers: { Location: '/' },
    status: 303,
  }));
  const locked = await lock;
  assert.equal(locked.status, 303);
  await Promise.all(cleanup);
  assert.equal(harness.hooks.state().lockRequestsPending, 0);
  assert.equal(harness.hooks.state().accessAllowed, false);
});

test('offline media cannot read private cache while purge is pending', async () => {
  const harness = createWorkerHarness();
  await authorize(harness);
  const mediaUrl = 'https://gba.gl/albums/photos/7/content';
  harness.cacheData.get(harness.hooks.state().cacheName).set(
    mediaUrl,
    response('cached photo', { contentType: 'image/jpeg' }),
  );
  const deletion = deferred();
  harness.state.deleteImpl = async () => deletion.promise;
  const purge = harness.hooks.revokePrivateData();
  harness.state.fetchImpl = async () => { throw new Error('offline'); };
  const media = harness.hooks.protectedMediaResponse(new Request(mediaUrl));
  let mediaResolved = false;
  void media.then(() => { mediaResolved = true; });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(mediaResolved, false);
  assert.equal(harness.state.privateMatchCalls, 0);

  deletion.resolve(true);
  await purge;
  const unavailable = await media;
  assert.equal(unavailable.status, 503);
  assert.equal(await unavailable.text(), 'Photo unavailable offline.');
  assert.equal(harness.state.privateMatchCalls, 0);
});

test('purge failure remains revoked and cannot expose disk residue', async () => {
  const harness = createWorkerHarness();
  await authorize(harness);
  harness.state.deleteImpl = async () => { throw new Error('disk failure'); };

  await harness.hooks.revokePrivateData();
  assert.equal(harness.hooks.state().accessAllowed, false);
  const residueCache = [...harness.cacheData.entries()].find(
    ([name]) => name.startsWith('gbagl-private-v1-'),
  );
  assert.equal(residueCache[1].size, 1);

  const offline = await offlineNavigation(harness);
  assert.equal(await offline.text(), 'safe offline shell');
  assert.equal(harness.state.privateMatchCalls, 0);

  await authorize(harness, 'fresh snapshot');
  assert.notEqual(harness.hooks.state().cacheName, residueCache[0]);
  const oldTimeline = 'https://gba.gl/timeline';
  residueCache[1].set(oldTimeline, response('old private timeline'));
  harness.state.fetchImpl = async () => { throw new Error('offline'); };
  const timeline = await harness.hooks.navigationResponse(new Request(oldTimeline));
  assert.equal(await timeline.text(), 'safe offline shell');
});

test('only a fresh authenticated opt-in response grants a newer generation', async () => {
  const harness = createWorkerHarness();
  await authorize(harness, 'initial snapshot');
  const initialGeneration = harness.hooks.state().generation;
  const staleResponse = deferred();
  harness.state.fetchImpl = async () => staleResponse.promise;
  const staleAuthorization = harness.hooks.authorizePrivateCache('https://gba.gl/');

  await harness.hooks.revokePrivateData();
  const revokedGeneration = harness.hooks.state().generation;
  assert.ok(revokedGeneration > initialGeneration);
  staleResponse.resolve(response('stale snapshot', {
    cacheOptIn: policy.SNAPSHOT_OPT_IN,
  }));
  await staleAuthorization;
  assert.equal(harness.hooks.state().accessAllowed, false);
  assert.equal(harness.hooks.state().generation, revokedGeneration);

  await authorize(harness, 'fresh snapshot');
  assert.ok(harness.hooks.state().generation > revokedGeneration);
  const cached = await offlineNavigation(harness);
  assert.equal(cached.status, 200);
  assert.equal(await cached.text(), 'fresh snapshot');
});

test('authenticated snapshot refreshes preserve the active private cache', async () => {
  const harness = createWorkerHarness();
  await authorize(harness, 'home snapshot');
  const cacheName = harness.hooks.state().cacheName;
  const generation = harness.hooks.state().generation;
  harness.state.fetchImpl = async () => response('timeline snapshot', {
    cacheOptIn: policy.SNAPSHOT_OPT_IN,
  });
  await harness.hooks.authorizePrivateCache('https://gba.gl/timeline');

  assert.equal(harness.hooks.state().cacheName, cacheName);
  assert.equal(harness.hooks.state().generation, generation);
  harness.state.fetchImpl = async () => { throw new Error('offline'); };
  const home = await harness.hooks.navigationResponse(new Request('https://gba.gl/'));
  const timeline = await harness.hooks.navigationResponse(
    new Request('https://gba.gl/timeline'),
  );
  assert.equal(await home.text(), 'home snapshot');
  assert.equal(await timeline.text(), 'timeline snapshot');
});

test('revocation prevents an older in-flight media response from caching', async () => {
  const harness = createWorkerHarness();
  await authorize(harness);
  const mediaResponse = deferred();
  harness.state.fetchImpl = async () => mediaResponse.promise;
  const mediaRequest = new Request('https://gba.gl/albums/photos/7/content');
  const inFlight = harness.hooks.protectedMediaResponse(mediaRequest);

  await harness.hooks.revokePrivateData();
  mediaResponse.resolve(response('photo', {
    cacheOptIn: policy.MEDIA_OPT_IN,
    contentType: 'image/jpeg',
  }));
  const networkResponse = await inFlight;
  assert.equal(await networkResponse.text(), 'photo');
  assert.equal(
    [...harness.cacheData.entries()]
      .filter(([name]) => name.startsWith('gbagl-private-v1-'))
      .some(([, entries]) => entries.has(mediaRequest.url)),
    false,
  );
  assert.equal(harness.hooks.state().accessAllowed, false);
});
