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

function createWorkerHarness(options = {}) {
  const cacheData = options.cacheData || new Map();
  if (!cacheData.has('gbagl-public-v1')) {
    cacheData.set('gbagl-public-v1', new Map([
      ['/offline.html', response('safe offline shell', { status: 503 })],
    ]));
  }
  const state = {
    clientsImpl: async () => [],
    deleteImpl: async (name) => cacheData.delete(name),
    fetchImpl: async () => { throw new Error('offline'); },
    getNotificationsImpl: async () => [],
    logs: [],
    privateMatchCalls: 0,
    stateReadError: options.stateReadError || false,
    stateKeysImpl: options.stateKeysImpl || (async (entries) => [...entries.keys()]),
    stateMatchImpl: options.stateMatchImpl
      || (async (entries, key) => entries.get(key)?.clone()),
    putImpl: async (entries, key, value) => {
      entries.set(key, value.clone());
    },
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
        async keys() {
          if (name === 'gbagl-state-v1' && state.stateReadError) {
            throw new Error('state read failure');
          }
          const keys = name === 'gbagl-state-v1'
            ? await state.stateKeysImpl(entries)
            : [...entries.keys()];
          return keys.map((key) => new Request(key));
        },
        async match(request) {
          if (name === 'gbagl-state-v1' && state.stateReadError) {
            throw new Error('state read failure');
          }
          if (name === 'gbagl-state-v1') {
            return state.stateMatchImpl(entries, cacheKey(request));
          }
          return entries.get(cacheKey(request))?.clone();
        },
        async put(request, value) {
          await state.putImpl(entries, cacheKey(request), value, name);
        },
        async delete(request) {
          return entries.delete(cacheKey(request));
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
      matchAll: (...args) => state.clientsImpl(...args),
    },
    location: { origin: 'https://gba.gl' },
    crypto: { randomUUID: () => options.instance || 'worker-test' },
    registration: {
      getNotifications: (...args) => state.getNotificationsImpl(...args),
    },
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
      error(...args) {
        state.logs.push(args.map((value) => value?.stack || String(value)));
      },
      warn(...args) {
        state.logs.push(args.map((value) => value?.stack || String(value)));
      },
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
      maintenance: () => privateMaintenance,
      ready: privateStateReady,
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
  assert.equal(
    harness.hooks.state().accessAllowed,
    true,
    JSON.stringify(harness.state.logs),
  );
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
  assert.equal(harness.hooks.state().lockRequestsPending, 0);
  await Promise.all(cleanup);
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
  const putStarted = deferred();
  const finishPut = deferred();
  harness.state.deleteImpl = async () => { throw new Error('disk failure'); };
  harness.state.putImpl = async (entries, key, value) => {
    entries.set(key, value.clone());
    putStarted.resolve();
    await finishPut.promise;
  };
  harness.state.fetchImpl = async () => response('photo', {
    cacheOptIn: policy.MEDIA_OPT_IN,
    contentType: 'image/jpeg',
  });
  const mediaRequest = new Request('https://gba.gl/albums/photos/7/content');
  const inFlight = harness.hooks.protectedMediaResponse(mediaRequest);

  await putStarted.promise;
  const purge = harness.hooks.revokePrivateData();
  assert.equal(harness.hooks.state().accessAllowed, false);
  finishPut.resolve();
  const networkResponse = await inFlight;
  await purge;
  assert.equal(await networkResponse.text(), 'photo');
  assert.equal(
    [...harness.cacheData.entries()]
      .filter(([name]) => name.startsWith('gbagl-private-v1-'))
      .some(([, entries]) => entries.has(mediaRequest.url)),
    false,
  );
  assert.equal(harness.hooks.state().accessAllowed, false);
});

test('notifications close independently when private cache deletion rejects', async () => {
  const harness = createWorkerHarness();
  await authorize(harness);
  let closed = 0;
  harness.state.deleteImpl = async () => { throw new Error('disk failure'); };
  harness.state.getNotificationsImpl = async () => [
    { close: () => { closed += 1; } },
    { close: () => { closed += 1; } },
  ];

  await harness.hooks.revokePrivateData();

  assert.equal(harness.hooks.state().accessAllowed, false);
  assert.equal(closed, 2);
});

test('auth loss returns immediately and backgrounds independent revocation cleanup', async () => {
  const harness = createWorkerHarness();
  await authorize(harness);
  const deletion = deferred();
  const lifetimes = [];
  const messages = [];
  let closed = 0;
  harness.state.deleteImpl = async () => deletion.promise;
  harness.state.getNotificationsImpl = async () => [
    { close: () => { closed += 1; } },
  ];
  harness.state.clientsImpl = async () => [{
    postMessage: (message) => messages.push(message),
  }];
  harness.state.fetchImpl = async () => response('locked', { status: 401 });

  const authResponse = await harness.hooks.navigationResponse(
    new Request('https://gba.gl/'),
    (promise) => lifetimes.push(promise),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(authResponse.status, 401);
  assert.equal(harness.hooks.state().accessAllowed, false);
  assert.equal(closed, 1);
  assert.equal(messages[0].type, 'AUTHORIZATION_LOST');
  assert.equal(lifetimes.length, 1);
  let cleanupSettled = false;
  void lifetimes[0].then(() => { cleanupSettled = true; });
  await Promise.resolve();
  assert.equal(cleanupSettled, false);
  const revokedRecord = [...harness.cacheData.get('gbagl-state-v1').entries()]
    .find(([key]) => key.endsWith('-revoked'));
  const stored = await revokedRecord[1].clone().json();
  assert.equal(stored.authorized, false);

  deletion.resolve(true);
  await Promise.all(lifetimes);
});

test('Lock Now response is not delayed by pending cache deletion', async () => {
  const harness = createWorkerHarness();
  await authorize(harness);
  const deletion = deferred();
  const lifetimes = [];
  harness.state.deleteImpl = async () => deletion.promise;
  harness.state.fetchImpl = async () => new Response(null, {
    headers: { Location: '/' },
    status: 303,
  });
  const lockUrl = new URL('https://gba.gl/lock');

  const locked = await harness.hooks.mutationResponse(
    new Request(lockUrl, { method: 'POST' }),
    lockUrl,
    (promise) => lifetimes.push(promise),
  );

  assert.equal(locked.status, 303);
  assert.equal(harness.hooks.state().accessAllowed, false);
  assert.equal(harness.hooks.state().lockRequestsPending, 0);
  assert.ok(lifetimes.length >= 2);
  deletion.resolve(true);
  await Promise.all(lifetimes);
});

test('worker restart restores the current authorized offline generation', async () => {
  const first = createWorkerHarness({ instance: 'worker-one' });
  await authorize(first, 'persisted snapshot');
  const cacheName = first.hooks.state().cacheName;

  const restarted = createWorkerHarness({
    cacheData: first.cacheData,
    instance: 'worker-two',
  });
  await restarted.hooks.ready;
  const offline = await offlineNavigation(restarted);

  assert.equal(restarted.hooks.state().accessAllowed, true);
  assert.equal(restarted.hooks.state().cacheName, cacheName);
  assert.equal(await offline.text(), 'persisted snapshot');
});

test('persisted revocation prevents worker restart from recovering residue', async () => {
  const first = createWorkerHarness({ instance: 'worker-one' });
  await authorize(first, 'private residue');
  const residueName = first.hooks.state().cacheName;
  first.state.deleteImpl = async () => { throw new Error('disk failure'); };
  await first.hooks.revokePrivateData();
  assert.equal(first.cacheData.has(residueName), true);

  const restarted = createWorkerHarness({
    cacheData: first.cacheData,
    instance: 'worker-two',
  });
  await restarted.hooks.ready;
  const offline = await offlineNavigation(restarted);

  assert.equal(restarted.hooks.state().accessAllowed, false);
  assert.equal(await offline.text(), 'safe offline shell');
});

test('worker restart purges old-version and orphaned private caches', async () => {
  const first = createWorkerHarness({ instance: 'worker-one' });
  await authorize(first, 'current snapshot');
  const active = first.hooks.state().cacheName;
  first.cacheData.set('gbagl-private-v0-old-1', new Map());
  first.cacheData.set('gbagl-private-v1-orphan-9', new Map());

  const restarted = createWorkerHarness({
    cacheData: first.cacheData,
    instance: 'worker-two',
  });
  await restarted.hooks.ready;
  await restarted.hooks.maintenance();

  assert.equal(restarted.cacheData.has(active), true);
  assert.equal(restarted.cacheData.has('gbagl-private-v0-old-1'), false);
  assert.equal(restarted.cacheData.has('gbagl-private-v1-orphan-9'), false);
});

test('authorization state write failure keeps private access revoked', async () => {
  const harness = createWorkerHarness();
  harness.state.putImpl = async (entries, key, value) => {
    if (key.includes('__gbagl-private-state__')) throw new Error('state write failure');
    entries.set(key, value.clone());
  };
  harness.state.fetchImpl = async () => response('private snapshot', {
    cacheOptIn: policy.SNAPSHOT_OPT_IN,
  });

  await harness.hooks.authorizePrivateCache('https://gba.gl/');
  const offline = await offlineNavigation(harness);

  assert.equal(harness.hooks.state().accessAllowed, false);
  assert.equal(await offline.text(), 'safe offline shell');
});

test('authorization state read failure fails closed after worker restart', async () => {
  const first = createWorkerHarness({ instance: 'worker-one' });
  await authorize(first, 'private snapshot');
  const restarted = createWorkerHarness({
    cacheData: first.cacheData,
    instance: 'worker-two',
    stateReadError: true,
  });

  await restarted.hooks.ready;
  const offline = await offlineNavigation(restarted);

  assert.equal(restarted.hooks.state().accessAllowed, false);
  assert.equal(await offline.text(), 'safe offline shell');
});

test('stale authorized state write cannot overwrite a newer durable revocation', async () => {
  const first = createWorkerHarness({ instance: 'worker-one' });
  const authorizationWriteStarted = deferred();
  const finishAuthorizationWrite = deferred();
  first.state.deleteImpl = async () => { throw new Error('disk failure'); };
  first.state.putImpl = async (entries, key, value) => {
    entries.set(key, value.clone());
    if (key.endsWith('-authorized')) {
      authorizationWriteStarted.resolve();
      await finishAuthorizationWrite.promise;
    }
  };
  first.state.fetchImpl = async () => response('stale snapshot', {
    cacheOptIn: policy.SNAPSHOT_OPT_IN,
  });
  const authorization = first.hooks.authorizePrivateCache('https://gba.gl/');
  await authorizationWriteStarted.promise;

  const revocation = first.hooks.revokePrivateData();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    [...first.cacheData.get('gbagl-state-v1').keys()]
      .some((key) => key.endsWith('-revoked')),
    true,
  );
  const duringRace = createWorkerHarness({
    cacheData: first.cacheData,
    instance: 'worker-two',
  });
  await duringRace.hooks.ready;
  assert.equal(duringRace.hooks.state().accessAllowed, false);

  finishAuthorizationWrite.resolve();
  await Promise.all([authorization, revocation]);
  const afterRace = createWorkerHarness({
    cacheData: first.cacheData,
    instance: 'worker-three',
  });
  await afterRace.hooks.ready;
  const offline = await offlineNavigation(afterRace);
  assert.equal(afterRace.hooks.state().accessAllowed, false);
  assert.equal(await offline.text(), 'safe offline shell');
});

test('tombstone supersedes authorization when the primary revoked-state write fails', async () => {
  const first = createWorkerHarness({ instance: 'worker-one' });
  await authorize(first, 'private residue');
  const privateCache = first.hooks.state().cacheName;
  first.state.putImpl = async (entries, key, value) => {
    if (key.endsWith('-revoked')) throw new Error('state write failure');
    entries.set(key, value.clone());
  };
  first.state.deleteImpl = async (name) => {
    if (name === 'gbagl-state-v1') return first.cacheData.delete(name);
    throw new Error('private deletion failure');
  };

  await first.hooks.revokePrivateData();
  assert.equal(first.cacheData.has(privateCache), true);
  assert.equal(first.cacheData.has('gbagl-state-v1'), true);
  assert.equal(first.cacheData.has('gbagl-revocation-v1'), true);

  const restarted = createWorkerHarness({
    cacheData: first.cacheData,
    instance: 'worker-two',
  });
  await restarted.hooks.ready;
  const offline = await offlineNavigation(restarted);

  assert.equal(restarted.hooks.state().accessAllowed, false);
  assert.equal(await offline.text(), 'safe offline shell');
});

test('corrupt state fails closed and self-heals for later authorization', async () => {
  const cacheData = new Map([
    ['gbagl-state-v1', new Map([[
      'https://gba.gl/__gbagl-private-state__/corrupt',
      new Response('{not-json', {
        headers: { 'Content-Type': 'application/json' },
      }),
    ]])],
  ]);
  const failedClosed = createWorkerHarness({
    cacheData,
    instance: 'worker-one',
  });
  await failedClosed.hooks.ready;
  assert.equal(failedClosed.hooks.state().accessAllowed, false);

  await authorize(failedClosed, 'fresh snapshot');
  const restarted = createWorkerHarness({
    cacheData,
    instance: 'worker-two',
  });
  await restarted.hooks.ready;
  const offline = await offlineNavigation(restarted);

  assert.equal(restarted.hooks.state().accessAllowed, true);
  assert.equal(await offline.text(), 'fresh snapshot');
});

test('early revoke supersedes a higher stored authorization during restoration', async () => {
  const cacheName = 'gbagl-private-v1-old-worker-7';
  const cacheData = new Map([
    ['gbagl-public-v1', new Map([
      ['/offline.html', response('safe offline shell', { status: 503 })],
    ])],
    [cacheName, new Map([
      ['https://gba.gl/', response('generation seven snapshot')],
    ])],
    ['gbagl-state-v1', new Map([[
      'https://gba.gl/__gbagl-private-state__/7-authorized',
      response(JSON.stringify({
        authorized: true,
        baseRevision: 0,
        cacheName,
        generation: 7,
        schemaVersion: 2,
        version: 'v1',
      }), { contentType: 'application/json' }),
    ]])],
  ]);
  const restoration = deferred();
  const starting = createWorkerHarness({
    cacheData,
    instance: 'worker-starting',
    stateKeysImpl: async (entries) => {
      await restoration.promise;
      return [...entries.keys()];
    },
  });
  starting.state.deleteImpl = async () => { throw new Error('disk failure'); };

  const revoke = starting.hooks.revokePrivateData();
  assert.equal(starting.hooks.state().accessAllowed, false);
  restoration.resolve();
  await Promise.all([starting.hooks.ready, revoke]);

  const restarted = createWorkerHarness({
    cacheData,
    instance: 'worker-restarted',
  });
  restarted.state.deleteImpl = async () => { throw new Error('disk failure'); };
  await restarted.hooks.ready;
  const offline = await offlineNavigation(restarted);

  assert.equal(restarted.hooks.state().accessAllowed, false);
  assert.equal(await offline.text(), 'safe offline shell');
  assert.equal(restarted.state.privateMatchCalls, 0);
});

test('replacement worker reconciles a later revocation before offline cache read', async () => {
  const active = createWorkerHarness({ instance: 'worker-active' });
  await authorize(active, 'shared private snapshot');
  const replacement = createWorkerHarness({
    cacheData: active.cacheData,
    instance: 'worker-replacement',
  });
  await replacement.hooks.ready;
  assert.equal(replacement.hooks.state().accessAllowed, true);

  active.state.deleteImpl = async () => { throw new Error('disk failure'); };
  await active.hooks.revokePrivateData();
  replacement.state.deleteImpl = async () => { throw new Error('disk failure'); };
  const offline = await offlineNavigation(replacement);

  assert.equal(replacement.hooks.state().accessAllowed, false);
  assert.equal(await offline.text(), 'safe offline shell');
  assert.equal(replacement.state.privateMatchCalls, 0);
});

test('reconciliation tolerates a stale state key disappearing after listing', async () => {
  const active = createWorkerHarness({ instance: 'worker-active' });
  await authorize(active, 'current snapshot');
  const staleKey = 'https://gba.gl/__gbagl-private-state__/1-authorized';
  active.cacheData.get('gbagl-state-v1').set(staleKey, response(JSON.stringify({
    authorized: true,
    baseRevision: 0,
    cacheName: 'gbagl-private-v1-stale-1',
    generation: 1,
    schemaVersion: 2,
    version: 'v1',
  }), { contentType: 'application/json' }));
  active.state.stateMatchImpl = async (entries, key) => {
    if (key === staleKey) {
      entries.delete(key);
      return undefined;
    }
    return entries.get(key)?.clone();
  };

  const offline = await offlineNavigation(active);

  assert.equal(active.hooks.state().accessAllowed, true);
  assert.equal(await offline.text(), 'current snapshot');
});

test('independent tombstone defeats surviving auth after primary revoke failures', async () => {
  const active = createWorkerHarness({ instance: 'worker-active' });
  await authorize(active, 'private residue');
  const privateCache = active.hooks.state().cacheName;
  active.state.putImpl = async (entries, key, value, cacheName) => {
    if (cacheName === 'gbagl-state-v1' && key.endsWith('-revoked')) {
      throw new Error('primary revoked-state write failure');
    }
    entries.set(key, value.clone());
  };
  active.state.deleteImpl = async (name) => {
    if (name === 'gbagl-state-v1' || name === privateCache) {
      throw new Error('primary deletion failure');
    }
    return active.cacheData.delete(name);
  };

  await active.hooks.revokePrivateData();
  assert.equal(active.cacheData.has(privateCache), true);
  assert.equal(active.cacheData.has('gbagl-state-v1'), true);

  const restarted = createWorkerHarness({
    cacheData: active.cacheData,
    instance: 'worker-restarted',
  });
  restarted.state.deleteImpl = async () => { throw new Error('disk failure'); };
  await restarted.hooks.ready;
  const offline = await offlineNavigation(restarted);

  assert.equal(restarted.hooks.state().accessAllowed, false);
  assert.equal(await offline.text(), 'safe offline shell');
  assert.equal(restarted.state.privateMatchCalls, 0);
});

test('loss of the current auth record cannot fall back to an older tombstone', async () => {
  const active = createWorkerHarness({ instance: 'worker-active' });
  await authorize(active, 'initial snapshot');
  active.state.deleteImpl = async () => { throw new Error('disk failure'); };
  await active.hooks.revokePrivateData();
  active.state.deleteImpl = async (name) => active.cacheData.delete(name);
  await authorize(active, 'new authorized snapshot');

  const replacement = createWorkerHarness({
    cacheData: active.cacheData,
    instance: 'worker-replacement',
  });
  await replacement.hooks.ready;
  await replacement.hooks.maintenance();
  assert.equal(replacement.hooks.state().accessAllowed, true);
  const stateEntries = replacement.cacheData.get('gbagl-state-v1');
  const currentAuthKey = [...stateEntries.keys()].find((key) => key.endsWith('-authorized'));
  stateEntries.delete(currentAuthKey);

  const offline = await offlineNavigation(replacement);

  assert.equal(replacement.hooks.state().accessAllowed, false);
  assert.equal(await offline.text(), 'safe offline shell');
});

test('authorization begun before a cross-worker revoke cannot grant afterward', async () => {
  const seed = createWorkerHarness({ instance: 'worker-seed' });
  await authorize(seed, 'initial snapshot');
  const workerA = createWorkerHarness({
    cacheData: seed.cacheData,
    instance: 'worker-a',
  });
  const workerB = createWorkerHarness({
    cacheData: seed.cacheData,
    instance: 'worker-b',
  });
  await Promise.all([workerA.hooks.ready, workerB.hooks.ready]);
  const observedBaseRevision = workerA.hooks.state().generation;
  const pendingSnapshot = deferred();
  workerA.state.fetchImpl = async () => pendingSnapshot.promise;
  const staleGrant = workerA.hooks.authorizePrivateCache('https://gba.gl/timeline');

  workerB.state.deleteImpl = async () => { throw new Error('disk failure'); };
  await workerB.hooks.revokePrivateData();
  pendingSnapshot.resolve(response('stale timeline', {
    cacheOptIn: policy.SNAPSHOT_OPT_IN,
  }));
  await staleGrant;

  const denied = await offlineNavigation(workerA);
  assert.equal(workerA.hooks.state().accessAllowed, false);
  assert.equal(await denied.text(), 'safe offline shell');
  const recordsAfterStaleGrant = await Promise.all(
    [...workerA.cacheData.get('gbagl-state-v1').values()]
      .map((value) => value.clone().json()),
  );
  const latestRevocation = Math.max(...recordsAfterStaleGrant
    .filter((value) => value.authorized === false)
    .map((value) => value.generation));
  assert.equal(recordsAfterStaleGrant.some((value) => (
    value.authorized === true
    && value.baseRevision < latestRevocation
    && value.generation > latestRevocation
  )), false);

  const staleWriteRevision = latestRevocation + 1;
  const staleCacheName = `gbagl-private-v1-worker-a-${staleWriteRevision}`;
  workerA.cacheData.set(staleCacheName, new Map([
    ['https://gba.gl/', response('synthetic stale resurrection')],
  ]));
  workerA.cacheData.get('gbagl-state-v1').set(
    `https://gba.gl/__gbagl-private-state__/${staleWriteRevision}-authorized`,
    response(JSON.stringify({
      authorized: true,
      baseRevision: observedBaseRevision,
      cacheName: staleCacheName,
      generation: staleWriteRevision,
      schemaVersion: 2,
      version: 'v1',
    }), { contentType: 'application/json' }),
  );
  const resolver = createWorkerHarness({
    cacheData: seed.cacheData,
    instance: 'worker-resolver',
  });
  resolver.state.deleteImpl = async () => { throw new Error('disk failure'); };
  await resolver.hooks.ready;
  const staleResolution = await offlineNavigation(resolver);
  assert.equal(resolver.hooks.state().accessAllowed, false);
  assert.equal(await staleResolution.text(), 'safe offline shell');
  assert.equal(resolver.state.privateMatchCalls, 0);

  const workerC = createWorkerHarness({
    cacheData: seed.cacheData,
    instance: 'worker-c',
  });
  await workerC.hooks.ready;
  await authorize(workerC, 'fresh post-revoke snapshot');
  const allowed = await offlineNavigation(workerC);
  assert.equal(workerC.hooks.state().accessAllowed, true);
  assert.equal(await allowed.text(), 'fresh post-revoke snapshot');
});

test('legacy authorization records fail closed under the state schema bump', async () => {
  const cacheName = 'gbagl-private-v1-legacy-worker-7';
  const cacheData = new Map([
    [cacheName, new Map([
      ['https://gba.gl/', response('legacy private snapshot')],
    ])],
    ['gbagl-state-v1', new Map([[
      'https://gba.gl/__gbagl-private-state__/7-authorized',
      response(JSON.stringify({
        authorized: true,
        cacheName,
        generation: 7,
        version: 'v1',
      }), { contentType: 'application/json' }),
    ]])],
  ]);
  const upgraded = createWorkerHarness({
    cacheData,
    instance: 'worker-upgraded',
  });
  upgraded.state.deleteImpl = async () => { throw new Error('disk failure'); };
  await upgraded.hooks.ready;
  const offline = await offlineNavigation(upgraded);

  assert.equal(upgraded.hooks.state().accessAllowed, false);
  assert.equal(await offline.text(), 'safe offline shell');
  assert.equal(upgraded.state.privateMatchCalls, 0);
});

test('slower authorization cannot overwrite a newer cross-worker grant', async () => {
  const cacheData = new Map();
  const workerA = createWorkerHarness({
    cacheData,
    instance: 'worker-a',
  });
  const workerB = createWorkerHarness({
    cacheData,
    instance: 'worker-b',
  });
  await Promise.all([workerA.hooks.ready, workerB.hooks.ready]);
  const stalePutStarted = deferred();
  const finishStalePut = deferred();
  workerA.state.fetchImpl = async () => response('stale snapshot', {
    cacheOptIn: policy.SNAPSHOT_OPT_IN,
  });
  workerA.state.putImpl = async (entries, key, value, cacheName) => {
    entries.set(key, value.clone());
    if (cacheName.startsWith('gbagl-private-v1-')) {
      stalePutStarted.resolve();
      await finishStalePut.promise;
    }
  };
  const staleAuthorization = workerA.hooks.authorizePrivateCache('https://gba.gl/');
  await stalePutStarted.promise;

  await authorize(workerB, 'fresh snapshot');
  finishStalePut.resolve();
  await staleAuthorization;

  const restarted = createWorkerHarness({
    cacheData,
    instance: 'worker-restarted',
  });
  await restarted.hooks.ready;
  const offline = await offlineNavigation(restarted);

  assert.equal(restarted.hooks.state().accessAllowed, true);
  assert.equal(await offline.text(), 'fresh snapshot');
});
