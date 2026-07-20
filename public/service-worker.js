importScripts('/js/pwaPolicy.js');

const CACHE_VERSION = 'v1';
const PUBLIC_CACHE = `gbagl-public-${CACHE_VERSION}`;
const PRIVATE_CACHE_ROOT = 'gbagl-private-';
const PRIVATE_CACHE_PREFIX = `${PRIVATE_CACHE_ROOT}${CACHE_VERSION}-`;
const STATE_CACHE_ROOT = 'gbagl-state-';
const STATE_CACHE = `${STATE_CACHE_ROOT}${CACHE_VERSION}`;
const STATE_PATH = '/__gbagl-private-state__/';
const REVOCATION_CACHE_ROOT = 'gbagl-revocation-';
const REVOCATION_CACHE = `${REVOCATION_CACHE_ROOT}${CACHE_VERSION}`;
const REVOCATION_KEY = new Request(
  new URL('/__gbagl-private-revocation__', self.location.origin).href,
);
const PRIVATE_INSTANCE = self.crypto.randomUUID();
const policy = self.gbaglPwaPolicy;
let privateGeneration = 0;
let privateAccessAllowed = false;
let activePrivateCache = null;
let lockRequestsPending = 0;
let revocationsPending = 0;
let privateCacheQueue = Promise.resolve();
let privateMaintenance = Promise.resolve();

function withPrivateCache(work) {
  const operation = privateCacheQueue.then(work, work);
  privateCacheQueue = operation.catch(() => {});
  return operation;
}

function privateCacheName(generation) {
  return `${PRIVATE_CACHE_PREFIX}${PRIVATE_INSTANCE}-${generation}`;
}

function stateRequest(value) {
  const disposition = value.authorized ? 'authorized' : 'revoked';
  return new Request(new URL(
    `${STATE_PATH}${value.generation}-${disposition}`,
    self.location.origin,
  ).href);
}

async function persistStateRecord(value) {
  const cache = await caches.open(STATE_CACHE);
  await cache.put(stateRequest(value), new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function persistRevocationTombstone(value) {
  const cache = await caches.open(REVOCATION_CACHE);
  await cache.put(REVOCATION_KEY, new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

function revokedState(generation) {
  return {
    authorized: false,
    cacheName: null,
    generation,
    version: CACHE_VERSION,
  };
}

function authorizedState(generation, cacheName) {
  return {
    authorized: true,
    cacheName,
    generation,
    version: CACHE_VERSION,
  };
}

function validAuthorizedState(value, cacheNames) {
  return value
    && value.version === CACHE_VERSION
    && value.authorized === true
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
    && typeof value.cacheName === 'string'
    && value.cacheName.startsWith(PRIVATE_CACHE_PREFIX)
    && cacheNames.includes(value.cacheName);
}

function validStateRecord(value) {
  return value
    && value.version === CACHE_VERSION
    && typeof value.authorized === 'boolean'
    && Number.isSafeInteger(value.generation)
    && value.generation > 0;
}

async function readDurableState() {
  const [stateCache, revocationCache] = await Promise.all([
    caches.open(STATE_CACHE),
    caches.open(REVOCATION_CACHE),
  ]);
  const [stateRequests, cacheNames, tombstoneResponse] = await Promise.all([
    stateCache.keys(),
    caches.keys(),
    revocationCache.match(REVOCATION_KEY),
  ]);
  const records = (await Promise.all(stateRequests.map(async (request) => {
    const response = await stateCache.match(request);
    if (!response) return null;
    return {
      request,
      value: await response.json(),
    };
  }))).filter(Boolean);
  if (tombstoneResponse) {
    records.push({
      request: null,
      value: await tombstoneResponse.json(),
    });
  }
  if (records.some((record) => !validStateRecord(record.value))) {
    throw new Error('Invalid private authorization state');
  }
  records.sort((left, right) => (
    right.value.generation - left.value.generation
    || Number(left.value.authorized) - Number(right.value.authorized)
  ));
  return {
    cacheNames,
    current: records[0] || null,
    stateCache,
    stateRequests,
  };
}

function applyDurableState(snapshot) {
  const stored = snapshot.current?.value || null;
  if (revocationsPending > 0) return false;
  if (!stored) {
    privateAccessAllowed = false;
    activePrivateCache = null;
    return false;
  }
  if (stored.generation < privateGeneration) {
    if (privateAccessAllowed) {
      privateAccessAllowed = false;
      activePrivateCache = null;
    }
    return false;
  }
  privateGeneration = stored.generation;
  if (validAuthorizedState(stored, snapshot.cacheNames)) {
    privateAccessAllowed = true;
    activePrivateCache = stored.cacheName;
    return true;
  }
  privateAccessAllowed = false;
  activePrivateCache = null;
  return false;
}

async function reconcilePrivateState() {
  try {
    const snapshot = await readDurableState();
    applyDurableState(snapshot);
    return snapshot;
  } catch (error) {
    privateGeneration += 1;
    privateAccessAllowed = false;
    activePrivateCache = null;
    console.error('GBAGL private authorization reconciliation failed closed:', error);
    throw error;
  }
}

function nextDurableGeneration(snapshot) {
  const durableGeneration = snapshot.current?.value?.generation || 0;
  return Math.max(Date.now(), durableGeneration + 1, privateGeneration + 1);
}

function deleteNamedCaches(names) {
  return Promise.allSettled(names.map((name) => caches.delete(name))).then((results) => {
    results
      .filter((result) => result.status === 'rejected')
      .forEach((result) => {
        console.error(
          'GBAGL private cache purge failed; access remains revoked:',
          result.reason,
        );
      });
  });
}

async function restorePrivateState() {
  const restoreGeneration = privateGeneration;
  try {
    const snapshot = await readDurableState();
    if (
      privateGeneration !== restoreGeneration
      || privateAccessAllowed
      || activePrivateCache
      || revocationsPending > 0
    ) return;
    applyDurableState(snapshot);
    const keep = privateAccessAllowed ? activePrivateCache : null;
    privateMaintenance = Promise.allSettled([
      deleteNamedCaches(snapshot.cacheNames.filter(
        (name) => name.startsWith(PRIVATE_CACHE_ROOT) && name !== keep,
      )),
      Promise.allSettled(snapshot.stateRequests
        .filter((request) => request.url !== snapshot.current?.request?.url)
        .map((request) => snapshot.stateCache.delete(request))),
    ]).then(() => undefined);
  } catch (error) {
    privateGeneration += 1;
    privateAccessAllowed = false;
    activePrivateCache = null;
    console.error('GBAGL private authorization state restore failed closed:', error);
    privateMaintenance = deletePrivateCaches();
    try {
      await Promise.all([
        caches.delete(STATE_CACHE),
        caches.delete(REVOCATION_CACHE),
      ]);
      await persistRevokedState(privateGeneration);
    } catch (writeError) {
      console.error('GBAGL revoked state persistence failed:', writeError);
    }
  }
}

const privateStateReady = restorePrivateState();

function privateStateMatches(expectedGeneration, expectedCache) {
  return privateAccessAllowed
    && expectedCache
    && expectedGeneration === privateGeneration
    && expectedCache === activePrivateCache;
}

async function deletePrivateCaches() {
  return withPrivateCache(async () => {
    let names;
    try {
      names = await caches.keys();
    } catch (error) {
      console.error('GBAGL private cache listing failed; access remains revoked:', error);
      return;
    }
    await deleteNamedCaches(names.filter(
      (name) => name.startsWith(PRIVATE_CACHE_ROOT),
    ));
  });
}

async function closeNotifications() {
  try {
    const notifications = await self.registration.getNotifications();
    const results = await Promise.allSettled(notifications.map(
      (notification) => Promise.resolve().then(() => notification.close()),
    ));
    results
      .filter((result) => result.status === 'rejected')
      .forEach((result) => {
        console.warn('GBAGL notification cleanup failed:', result.reason);
      });
  } catch (error) {
    console.warn('GBAGL notification cleanup failed:', error);
  }
}

async function notifyAuthorizationLost() {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    const results = await Promise.allSettled(clients.map(
      (client) => Promise.resolve().then(
        () => client.postMessage({ type: 'AUTHORIZATION_LOST' }),
      ),
    ));
    results
      .filter((result) => result.status === 'rejected')
      .forEach((result) => {
        console.warn('GBAGL authorization-loss notification failed:', result.reason);
      });
  } catch (error) {
    console.warn('GBAGL authorization-loss notification failed:', error);
  }
}

async function persistRevokedState(generation) {
  try {
    const snapshot = await readDurableState();
    const durableGeneration = Math.max(
      generation,
      nextDurableGeneration(snapshot),
    );
    const value = revokedState(durableGeneration);
    const results = await Promise.allSettled([
      persistStateRecord(value),
      persistRevocationTombstone(value),
    ]);
    if (results.every((result) => result.status === 'rejected')) {
      throw new AggregateError(
        results.map((result) => result.reason),
        'Durable revocation persistence failed',
      );
    }
    privateGeneration = Math.max(privateGeneration, durableGeneration);
    return durableGeneration;
  } catch (writeError) {
    try {
      await Promise.all([
        caches.delete(STATE_CACHE),
        caches.delete(REVOCATION_CACHE),
      ]);
    } catch (deleteError) {
      console.error('GBAGL authorization state invalidation failed:', deleteError);
    }
    throw writeError;
  }
}

function revokePrivateData(notifyClients = false) {
  privateGeneration += 1;
  privateAccessAllowed = false;
  activePrivateCache = null;
  revocationsPending += 1;
  const durableRevocation = persistRevokedState(privateGeneration)
    .catch((error) => {
      console.error('GBAGL revoked state persistence failed:', error);
    })
    .finally(() => {
      revocationsPending -= 1;
    });
  const cleanup = [
    durableRevocation,
    deletePrivateCaches(),
    closeNotifications(),
  ];
  if (notifyClients) cleanup.push(notifyAuthorizationLost());
  return Promise.allSettled(cleanup).then(() => undefined);
}

async function putPrivateCacheEntry(
  cache,
  request,
  response,
  expectedGeneration,
  expectedCache,
) {
  await reconcilePrivateState();
  if (!privateStateMatches(expectedGeneration, expectedCache)) return false;
  await cache.put(request, response);
  try {
    await reconcilePrivateState();
  } catch {
    await cache.delete(request);
    return false;
  }
  if (privateStateMatches(expectedGeneration, expectedCache)) return true;
  try {
    await cache.delete(request);
  } catch (error) {
    console.warn('GBAGL stale private cache write cleanup failed:', error);
  }

  return false;
}

async function persistAuthorizedState(cacheName) {
  const snapshot = await readDurableState();
  if (revocationsPending > 0) return null;
  const generation = nextDurableGeneration(snapshot);
  await persistStateRecord(authorizedState(generation, cacheName));
  return generation;
}

async function fetchWithAuthorizationCheck(request, extendLifetime = () => {}) {
  const response = await fetch(request);
  if (
    (response.status === 401 || response.status === 403)
    && response.headers.get('X-GBAGL-Authorization-Lost') === '1'
  ) {
    extendLifetime(revokePrivateData(true));
  }
  return response;
}

function isCacheableSnapshot(response) {
  return response.status === 200
    && !response.redirected
    && response.headers.get(policy.PRIVATE_SNAPSHOT_HEADER) === policy.SNAPSHOT_OPT_IN
    && response.headers.get('Content-Type')?.startsWith('text/html');
}

async function authorizePrivateCache(value, extendLifetime = () => {}) {
  await privateStateReady;
  try {
    await reconcilePrivateState();
  } catch {
    return;
  }
  const authorizationGeneration = privateGeneration;
  const canonicalUrl = policy.canonicalSnapshotUrl(value, self.location.origin);
  if (!canonicalUrl) return;
  const headers = new Headers({
    Accept: 'text/html',
    'X-GBAGL-Offline-Snapshot': '1',
  });
  const response = await fetchWithAuthorizationCheck(new Request(canonicalUrl, {
    cache: 'no-store',
    credentials: 'include',
    headers,
  }), extendLifetime);
  if (!isCacheableSnapshot(response)) return;
  try {
    await withPrivateCache(async () => {
      try {
        await reconcilePrivateState();
      } catch {
        return;
      }
      if (
        authorizationGeneration !== privateGeneration
        || lockRequestsPending > 0
        || revocationsPending > 0
      ) return;
      if (privateAccessAllowed && activePrivateCache) {
        const grantedGeneration = privateGeneration;
        const grantedCache = activePrivateCache;
        const cache = await caches.open(grantedCache);
        if (!privateStateMatches(grantedGeneration, grantedCache)) return;
        await putPrivateCacheEntry(
          cache,
          new Request(canonicalUrl),
          response,
          grantedGeneration,
          grantedCache,
        );
        return;
      }
      const provisionalGeneration = Math.max(Date.now(), privateGeneration + 1);
      const grantedCache = privateCacheName(provisionalGeneration);
      const request = new Request(canonicalUrl);
      const cache = await caches.open(grantedCache);
      await cache.put(request, response);
      if (
        authorizationGeneration !== privateGeneration
        || lockRequestsPending > 0
        || revocationsPending > 0
      ) {
        await cache.delete(request);
        return;
      }
      let grantedGeneration;
      try {
        grantedGeneration = await persistAuthorizedState(grantedCache);
      } catch (error) {
        await cache.delete(request);
        throw error;
      }
      if (!grantedGeneration) {
        await cache.delete(request);
        return;
      }
      try {
        await reconcilePrivateState();
      } catch {
        await cache.delete(request);
        return;
      }
      if (
        !privateStateMatches(grantedGeneration, grantedCache)
        || lockRequestsPending > 0
        || revocationsPending > 0
      ) await cache.delete(request);
    });
  } catch (error) {
    privateAccessAllowed = false;
    activePrivateCache = null;
    console.warn('GBAGL snapshot cache write failed:', error);
  }
}

async function privateCacheMatch(request, expectedGeneration, expectedCache) {
  try {
    return await withPrivateCache(async () => {
      await reconcilePrivateState();
      if (!privateStateMatches(expectedGeneration, expectedCache)) return null;
      const cached = await caches.match(request, { cacheName: expectedCache });
      await reconcilePrivateState();
      if (!privateStateMatches(expectedGeneration, expectedCache)) return null;
      return cached || null;
    });
  } catch (error) {
    console.error('GBAGL private cache read failed; using safe fallback:', error);
    return null;
  }
}

async function navigationResponse(request, extendLifetime = () => {}) {
  await privateStateReady;
  try {
    await reconcilePrivateState();
  } catch {
    return caches.match('/offline.html', { cacheName: PUBLIC_CACHE });
  }
  const canonicalUrl = policy.canonicalSnapshotUrl(request.url, self.location.origin);
  const expectedGeneration = privateGeneration;
  const expectedCache = activePrivateCache;
  try {
    return await fetchWithAuthorizationCheck(request, extendLifetime);
  } catch {
    if (canonicalUrl) {
      const cached = await privateCacheMatch(
        new Request(canonicalUrl),
        expectedGeneration,
        expectedCache,
      );
      if (cached) return cached;
    }
    return caches.match('/offline.html', { cacheName: PUBLIC_CACHE });
  }
}

async function protectedMediaResponse(request, extendLifetime = () => {}) {
  await privateStateReady;
  try {
    await reconcilePrivateState();
  } catch {
    return new Response('Photo unavailable offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const expectedGeneration = privateGeneration;
  const expectedCache = activePrivateCache;
  try {
    const response = await fetchWithAuthorizationCheck(request, extendLifetime);
    if (
      response.status === 200
      && !response.redirected
      && response.headers.get(policy.PRIVATE_SNAPSHOT_HEADER) === policy.MEDIA_OPT_IN
      && privateStateMatches(expectedGeneration, expectedCache)
    ) {
      try {
        await withPrivateCache(async () => {
          await reconcilePrivateState();
          if (!privateStateMatches(expectedGeneration, expectedCache)) return;
          const cache = await caches.open(expectedCache);
          if (!privateStateMatches(expectedGeneration, expectedCache)) return;
          await putPrivateCacheEntry(
            cache,
            request,
            response.clone(),
            expectedGeneration,
            expectedCache,
          );
        });
      } catch (error) {
        console.warn('GBAGL photo cache write failed:', error);
      }
    }
    return response;
  } catch {
    const cached = await privateCacheMatch(request, expectedGeneration, expectedCache);
    if (cached) return cached;
    return new Response('Photo unavailable offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function mutationResponse(request, url, extendLifetime = () => {}) {
  if (url.pathname !== '/lock') {
    await privateStateReady;
    return fetchWithAuthorizationCheck(request, extendLifetime);
  }
  lockRequestsPending += 1;
  const initialPurge = revokePrivateData();
  extendLifetime(initialPurge);
  try {
    return await fetchWithAuthorizationCheck(request, extendLifetime);
  } finally {
    lockRequestsPending -= 1;
    const finalPurge = revokePrivateData();
    extendLifetime(finalPurge);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PUBLIC_CACHE)
      .then((cache) => cache.addAll(policy.PUBLIC_SHELL_PATHS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    privateStateReady
      .then(() => reconcilePrivateState())
      .then(() => caches.keys())
      .then((names) => deleteNamedCaches(names.filter((name) => (
        (name.startsWith('gbagl-public-') && name !== PUBLIC_CACHE)
        || (name.startsWith(STATE_CACHE_ROOT) && name !== STATE_CACHE)
        || (name.startsWith(REVOCATION_CACHE_ROOT) && name !== REVOCATION_CACHE)
      ))))
      .then(() => privateMaintenance)
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEAR_PRIVATE_DATA') {
    event.waitUntil(revokePrivateData());
  } else if (event.data?.type === 'AUTHORIZE_PRIVATE_CACHE') {
    event.waitUntil(authorizePrivateCache(
      event.data.url,
      (promise) => event.waitUntil(promise),
    ));
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method !== 'GET') {
    event.respondWith(mutationResponse(
      request,
      url,
      (promise) => event.waitUntil(promise),
    ));
    return;
  }

  if (policy.PUBLIC_SHELL_PATHS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request, { cacheName: PUBLIC_CACHE })
        .then((cached) => cached || fetch(request)),
    );
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(
      request,
      (promise) => event.waitUntil(promise),
    ));
    return;
  }
  if (policy.isPrivateMediaPath(url.pathname)) {
    event.respondWith(protectedMediaResponse(
      request,
      (promise) => event.waitUntil(promise),
    ));
    return;
  }
  event.respondWith(fetchWithAuthorizationCheck(
    request,
    (promise) => event.waitUntil(promise),
  ));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = policy.notificationNavigation(
    event.notification.data?.url,
    self.location.origin,
  );
  if (!destination) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      return existing.navigate(destination);
    }
    return self.clients.openWindow(destination);
  })());
});
