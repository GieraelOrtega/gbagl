importScripts('/js/pwaPolicy.js');

const CACHE_VERSION = 'v1';
const PUBLIC_CACHE = `gbagl-public-${CACHE_VERSION}`;
const PRIVATE_CACHE = `gbagl-private-${CACHE_VERSION}`;
const policy = self.gbaglPwaPolicy;
let privateGeneration = 0;
let privateWritesAllowed = false;
let privateCacheQueue = Promise.resolve();

function withPrivateCache(work) {
  const operation = privateCacheQueue.then(work, work);
  privateCacheQueue = operation.catch(() => {});
  return operation;
}

async function clearPrivateData(notifyClients = false) {
  privateGeneration += 1;
  privateWritesAllowed = false;
  await withPrivateCache(async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('gbagl-private-'))
      .map((name) => caches.delete(name)));
  });
  try {
    const notifications = await self.registration.getNotifications();
    notifications.forEach((notification) => notification.close());
  } catch (error) {
    console.warn('GBAGL notification cleanup failed:', error);
  }
  if (notifyClients) {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    clients.forEach((client) => client.postMessage({ type: 'AUTHORIZATION_LOST' }));
  }
}

async function fetchWithAuthorizationCheck(request) {
  const response = await fetch(request);
  if (
    (response.status === 401 || response.status === 403)
    && response.headers.get('X-GBAGL-Authorization-Lost') === '1'
  ) {
    await clearPrivateData(true);
  }
  return response;
}

async function cacheReadOnlySnapshot(value, expectedGeneration) {
  if (!privateWritesAllowed || expectedGeneration !== privateGeneration) return;
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
  }));
  if (
    response.status !== 200
    || response.redirected
    || response.headers.get(policy.PRIVATE_SNAPSHOT_HEADER) !== policy.SNAPSHOT_OPT_IN
    || !response.headers.get('Content-Type')?.startsWith('text/html')
  ) return;
  try {
    await withPrivateCache(async () => {
      if (!privateWritesAllowed || expectedGeneration !== privateGeneration) return;
      const cache = await caches.open(PRIVATE_CACHE);
      await cache.put(new Request(canonicalUrl), response);
    });
  } catch (error) {
    console.warn('GBAGL snapshot cache write failed:', error);
  }
}

async function navigationResponse(request, extendLifetime) {
  const canonicalUrl = policy.canonicalSnapshotUrl(request.url, self.location.origin);
  const expectedGeneration = privateGeneration;
  try {
    const response = await fetchWithAuthorizationCheck(request);
    if (
      response.status === 200
      && !response.redirected
      && canonicalUrl
      && privateWritesAllowed
    ) {
      extendLifetime(cacheReadOnlySnapshot(canonicalUrl, expectedGeneration));
    }
    return response;
  } catch {
    if (canonicalUrl) {
      const cached = await caches.match(new Request(canonicalUrl), { cacheName: PRIVATE_CACHE });
      if (cached) return cached;
    }
    return caches.match('/offline.html', { cacheName: PUBLIC_CACHE });
  }
}

async function protectedMediaResponse(request) {
  const expectedGeneration = privateGeneration;
  try {
    const response = await fetchWithAuthorizationCheck(request);
    if (
      response.status === 200
      && !response.redirected
      && response.headers.get(policy.PRIVATE_SNAPSHOT_HEADER) === policy.MEDIA_OPT_IN
      && privateWritesAllowed
      && expectedGeneration === privateGeneration
    ) {
      try {
        await withPrivateCache(async () => {
          if (!privateWritesAllowed || expectedGeneration !== privateGeneration) return;
          const cache = await caches.open(PRIVATE_CACHE);
          await cache.put(request, response.clone());
        });
      } catch (error) {
        console.warn('GBAGL photo cache write failed:', error);
      }
    }
    return response;
  } catch {
    const cached = await caches.match(request, { cacheName: PRIVATE_CACHE });
    if (cached) return cached;
    return new Response('Photo unavailable offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function mutationResponse(request, url) {
  const response = await fetchWithAuthorizationCheck(request);
  if (url.pathname === '/lock') await clearPrivateData();
  return response;
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
          && name !== PUBLIC_CACHE
          && name !== PRIVATE_CACHE)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEAR_PRIVATE_DATA') {
    event.waitUntil(clearPrivateData());
  } else if (event.data?.type === 'AUTHORIZE_PRIVATE_CACHE') {
    privateGeneration += 1;
    privateWritesAllowed = true;
    const expectedGeneration = privateGeneration;
    event.waitUntil(cacheReadOnlySnapshot(event.data.url, expectedGeneration));
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method !== 'GET') {
    event.respondWith(mutationResponse(request, url));
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
    event.respondWith(navigationResponse(request, (promise) => event.waitUntil(promise)));
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
