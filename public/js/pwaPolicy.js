(function exposePolicy(root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  if (root) root.gbaglPwaPolicy = policy;
}(typeof self !== 'undefined' ? self : globalThis, () => {
  const PRIVATE_SNAPSHOT_HEADER = 'X-GBAGL-Private-Cache';
  const SNAPSHOT_OPT_IN = 'read-only-v1';
  const MEDIA_OPT_IN = 'media-v1';
  const PUBLIC_SHELL_PATHS = Object.freeze([
    '/offline.html',
    '/css/style.css?v=gk-ux-1',
    '/js/lock.js',
    '/js/pwa.js',
    '/js/pwaPolicy.js?v=gk-ux-1',
    '/js/theme.js',
    '/manifest.webmanifest?v=gk-ux-1',
    '/icons/icon-192.png?v=gk-ux-1',
    '/icons/icon-512.png?v=gk-ux-1',
  ]);

  function isPrivateSnapshotPath(pathname) {
    return [
      '/',
      '/timeline',
      '/bucket',
      '/reminders',
      '/albums',
      '/journal',
    ].includes(pathname) || /^\/albums\/[1-9]\d*$/.test(pathname);
  }

  function isPrivateMediaPath(pathname) {
    return pathname === '/media/home-photo'
      || /^\/albums\/photos\/[1-9]\d*\/content$/.test(pathname);
  }

  function sameOriginUrl(value, origin) {
    try {
      const url = new URL(value, origin);
      return url.origin === origin ? url : null;
    } catch {
      return null;
    }
  }

  function canonicalSnapshotUrl(value, origin) {
    const url = sameOriginUrl(value, origin);
    if (!url || !isPrivateSnapshotPath(url.pathname)) return null;
    return `${origin}${url.pathname}`;
  }

  function notificationNavigation(value, origin) {
    const url = sameOriginUrl(value, origin);
    if (!url || !isPrivateSnapshotPath(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  }

  return Object.freeze({
    MEDIA_OPT_IN,
    PRIVATE_SNAPSHOT_HEADER,
    PUBLIC_SHELL_PATHS,
    SNAPSHOT_OPT_IN,
    canonicalSnapshotUrl,
    isPrivateMediaPath,
    isPrivateSnapshotPath,
    notificationNavigation,
    sameOriginUrl,
  });
}));
