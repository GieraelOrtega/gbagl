importScripts('/js/pwaPolicy.js');

const CACHE_VERSION = 'v1';
const PUBLIC_CACHE = `gbagl-public-${CACHE_VERSION}`;
const PRIVATE_CACHE_ROOT = 'gbagl-private-';
const PRIVATE_CACHE_PREFIX = `${PRIVATE_CACHE_ROOT}${CACHE_VERSION}-`;
const PRIVATE_INSTANCE = self.crypto.randomUUID();
const policy = self.gbaglPwaPolicy;
let privateGeneration = 0;
let privateAccessAllowed = false;
let activePrivateCache = null;
let lockRequestsPending = 0;
let privateCacheQueue = Promise.resolve();

function withPrivateCache(work) {
  const operation = privateCacheQueue.then(work, work);
  privateCacheQueue = operation.catch(() => {});
  return operation;
}

function privateCacheName(generation) {
  return `${PRIVATE_CACHE_PREFIX}${PRIVATE_INSTANCE}-${generation}`;
}

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
    const results = await Promise.allSettled(names
      .filter((name) => name.startsWith(PRIVATE_CACHE_ROOT))
      .map((name) => caches.delete(name)));
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

function revokePrivateData(notifyClients = false) {
  privateGeneration += 1;
  privateAccessAllowed = false;
  activePrivateCache = null;
  const cleanup = [
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
  await cache.put(request, response);
  if (privateStateMatches(expectedGeneration, expectedCache)) return true;
  try {
    await cache.delete(request);
  } catch (error) {
    console.warn('GBAGL stale private cache write cleanup failed:', error);
  }
  return false;
}

async function fetchWithAuthorizationCheck(request) {
  const response = await fetch(request);
  if (
    (response.status === 401 || response.status === 403)
    && response.headers.get('X-GBAGL-Authorization-Lost') === '1'
  ) {
    await revokePrivateData(true);
  }
  return response;
}

function isCacheableSnapshot(response) {
  return response.status === 200
    && !response.redirected
    && response.headers.get(policy.PRIVATE_SNAPSHOT_HEADER) === policy.SNAPSHOT_OPT_IN
    && response.headers.get('Content-Type')?.startsWith('text/html');
}

async function authorizePrivateCache(value) {
  const canonicalUrl = policy.canonicalSnapshotUrl(value, self.location.origin);
  if (!canonicalUrl) return;
  const authorizationGeneration = privateGeneration;
  const headers = new Headers({
    Accept: 'text/html',
    'X-GBAGL-Offline-Snapshot': '1',
  });
  const response = await fetchWithAuthorizationCheck(new Request(canonicalUrl, {
    cache: 'no-store',
    credentials: 'include',
    headers,
  }));
  if (!isCacheableSnapshot(response)) return;
  try {
    await withPrivateCache(async () => {
      if (
        authorizationGeneration !== privateGeneration
        || lockRequestsPending > 0
      ) return;
      let grantedGeneration = privateGeneration;
      let grantedCache = activePrivateCache;
      if (!privateAccessAllowed || !grantedCache) {
        privateGeneration += 1;
        privateAccessAllowed = true;
        grantedGeneration = privateGeneration;
        grantedCache = privateCacheName(grantedGeneration);
        activePrivateCache = grantedCache;
      }
      const cache = await caches.open(grantedCache);
      if (!privateStateMatches(grantedGeneration, grantedCache)) return;
      await putPrivateCacheEntry(
        cache,
        new Request(canonicalUrl),
        response,
        grantedGeneration,
        grantedCache,
      );
    });
  } catch (error) {
    console.warn('GBAGL snapshot cache write failed:', error);
  }
}

async function privateCacheMatch(request, expectedGeneration, expectedCache) {
  try {
    return await withPrivateCache(async () => {
      if (!privateStateMatches(expectedGeneration, expectedCache)) return null;
      const cached = await caches.match(request, { cacheName: expectedCache });
      if (!privateStateMatches(expectedGeneration, expectedCache)) return null;
      return cached || null;
    });
  } catch (error) {
    console.error('GBAGL private cache read failed; using safe fallback:', error);
    return null;
  }
}

async function navigationResponse(request) {
  const canonicalUrl = policy.canonicalSnapshotUrl(request.url, self.location.origin);
  const expectedGeneration = privateGeneration;
  const expectedCache = activePrivateCache;
  try {
    return await fetchWithAuthorizationCheck(request);
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

async function protectedMediaResponse(request) {
  const expectedGeneration = privateGeneration;
  const expectedCache = activePrivateCache;
  try {
    const response = await fetchWithAuthorizationCheck(request);
    if (
      response.status === 200
      && !response.redirected
      && response.headers.get(policy.PRIVATE_SNAPSHOT_HEADER) === policy.MEDIA_OPT_IN
      && privateStateMatches(expectedGeneration, expectedCache)
    ) {
      try {
        await withPrivateCache(async () => {
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
  if (url.pathname !== '/lock') return fetchWithAuthorizationCheck(request);
  lockRequestsPending += 1;
  const initialPurge = revokePrivateData();
  try {
    return await fetchWithAuthorizationCheck(request);
  } finally {
    const finalPurge = revokePrivateData();
    extendLifetime(
      Promise.allSettled([initialPurge, finalPurge])
        .finally(() => { lockRequestsPending -= 1; }),
    );
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
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.startsWith('gbagl-')
          && name !== PUBLIC_CACHE)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEAR_PRIVATE_DATA') {
    event.waitUntil(revokePrivateData());
  } else if (event.data?.type === 'AUTHORIZE_PRIVATE_CACHE') {
    event.waitUntil(authorizePrivateCache(event.data.url));
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
    event.respondWith(navigationResponse(request));
    return;
  }
  if (policy.isPrivateMediaPath(url.pathname)) {
    event.respondWith(protectedMediaResponse(request));
    return;
  }
  event.respondWith(fetchWithAuthorizationCheck(request));
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
