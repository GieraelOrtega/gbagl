const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  MEDIA_OPT_IN,
  PUBLIC_SHELL_PATHS,
  SNAPSHOT_OPT_IN,
  canonicalSnapshotUrl,
  isPrivateMediaPath,
  isPrivateSnapshotPath,
  notificationNavigation,
} = require('../public/js/pwaPolicy');

test('PWA policy separates public shell, read-only snapshots, and protected media', () => {
  assert.ok(PUBLIC_SHELL_PATHS.includes('/offline.html'));
  assert.ok(PUBLIC_SHELL_PATHS.includes('/icons/icon-512.png'));
  assert.equal(PUBLIC_SHELL_PATHS.some((item) => item.startsWith('/admin')), false);
  assert.equal(isPrivateSnapshotPath('/'), true);
  assert.equal(isPrivateSnapshotPath('/albums/42'), true);
  assert.equal(isPrivateSnapshotPath('/admin'), false);
  assert.equal(isPrivateSnapshotPath('/reminders/feed.json'), false);
  assert.equal(isPrivateMediaPath('/albums/photos/8/content'), true);
  assert.equal(isPrivateMediaPath('/images/private.jpg'), false);
  assert.equal(SNAPSHOT_OPT_IN, 'read-only-v1');
  assert.equal(MEDIA_OPT_IN, 'media-v1');
});

test('snapshot and notification destinations require an allowlisted same-origin URL', () => {
  const origin = 'https://gba.gl';
  assert.equal(
    canonicalSnapshotUrl('https://gba.gl/albums/7?ignored=1', origin),
    'https://gba.gl/albums/7',
  );
  assert.equal(canonicalSnapshotUrl('https://evil.example/albums/7', origin), null);
  assert.equal(canonicalSnapshotUrl('/admin', origin), null);
  assert.equal(
    notificationNavigation('/reminders?view=upcoming#event-4', origin),
    '/reminders?view=upcoming#event-4',
  );
  assert.equal(notificationNavigation('//evil.example/reminders', origin), null);
  assert.equal(notificationNavigation('/admin', origin), null);
});

test('manifest icons are real PNGs with declared maskable dimensions', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'public', 'manifest.webmanifest'),
    'utf8',
  ));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  for (const expectedSize of [192, 512]) {
    const icon = manifest.icons.find((item) => item.sizes === `${expectedSize}x${expectedSize}`);
    assert.match(icon.purpose, /maskable/);
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'public', icon.src.slice(1)));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(bytes.readUInt32BE(16), expectedSize);
    assert.equal(bytes.readUInt32BE(20), expectedSize);
  }
});

test('service worker implements version cleanup, auth purge, and explicit clear messages', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'service-worker.js'),
    'utf8',
  );
  assert.match(source, /gbagl-public-\$\{CACHE_VERSION\}/);
  assert.match(source, /gbagl-private-/);
  assert.match(source, /response\.status === 401 \|\| response\.status === 403/);
  assert.match(source, /X-GBAGL-Authorization-Lost/);
  assert.match(source, /CLEAR_PRIVATE_DATA/);
  assert.match(source, /AUTHORIZE_PRIVATE_CACHE/);
  assert.match(source, /authorizationGeneration !== privateGeneration/);
  assert.match(source, /withPrivateCache/);
  assert.match(source, /mutationResponse/);
  assert.match(source, /url\.pathname !== '\/lock'/);
  assert.match(source, /authorizePrivateCache/);
  assert.doesNotMatch(source, /\/admin\/|feed\.json|backups/);
});

test('offline shell styling cannot be mistaken for the authenticated lock response', () => {
  const offline = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'offline.html'),
    'utf8',
  );
  const lock = fs.readFileSync(path.join(__dirname, '..', 'views', 'lock.ejs'), 'utf8');
  assert.doesNotMatch(offline, /data-locked-state/);
  assert.match(lock, /data-locked-state/);
});

test('shared navigation and lock screen keep only read-only network status visible', () => {
  const nav = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'partials', 'nav.ejs'),
    'utf8',
  );
  const lock = fs.readFileSync(path.join(__dirname, '..', 'views', 'lock.ejs'), 'utf8');

  assert.doesNotMatch(nav, /✨ Adventure|📖 Timeline/);
  assert.match(nav, />Adventure</);
  assert.match(nav, />Timeline</);
  assert.doesNotMatch(nav, />Online</);
  assert.match(nav, /Offline · read-only copies/);
  assert.match(nav, /data-network-status-announcer/);
  assert.doesNotMatch(lock, /This little corner of the internet is private\./);
  assert.doesNotMatch(lock, />Online</);
  assert.match(lock, /data-pwa-controls hidden/);
});
