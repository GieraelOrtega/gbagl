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
  assert.ok(PUBLIC_SHELL_PATHS.includes('/js/theme.js'));
  assert.equal(PUBLIC_SHELL_PATHS.some((item) => item.startsWith('/settings')), false);
  assert.equal(isPrivateSnapshotPath('/'), true);
  assert.equal(isPrivateSnapshotPath('/albums/42'), true);
  assert.equal(isPrivateSnapshotPath('/settings'), false);
  assert.equal(isPrivateSnapshotPath('/reminders/feed.json'), false);
  assert.equal(isPrivateMediaPath('/albums/photos/8/content'), true);
  assert.equal(isPrivateMediaPath('/media/home-photo'), true);
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
  assert.equal(canonicalSnapshotUrl('/settings', origin), null);
  assert.equal(
    notificationNavigation('/reminders?view=upcoming#event-4', origin),
    '/reminders?view=upcoming#event-4',
  );
  assert.equal(notificationNavigation('//evil.example/reminders', origin), null);
  assert.equal(notificationNavigation('/settings', origin), null);
});

test('manifest icons are real PNGs with declared maskable dimensions', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'public', 'manifest.webmanifest'),
    'utf8',
  ));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.display_override, undefined);
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
  assert.match(source, /cacheAuthorizedMedia/);
  assert.match(source, /authorizationGeneration !== privateGeneration/);
  assert.match(source, /withPrivateCache/);
  assert.match(source, /mutationResponse/);
  assert.match(source, /url\.pathname !== '\/lock'/);
  assert.match(source, /authorizePrivateCache/);
  assert.doesNotMatch(source, /\/settings\/|feed\.json|backups/);
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

test('install control appears only at the lock-screen bottom and Online text is absent', () => {
  const nav = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'partials', 'nav.ejs'),
    'utf8',
  );
  const lock = fs.readFileSync(path.join(__dirname, '..', 'views', 'lock.ejs'), 'utf8');

  assert.doesNotMatch(nav, /✨ Adventure|📖 Timeline/);
  assert.match(nav, />Adventure</);
  assert.match(nav, />Timeline</);
  assert.match(nav, />Settings</);
  assert.doesNotMatch(nav, /Lock Now|data-install-app/);
  assert.doesNotMatch(nav, />Online</);
  assert.match(nav, /Offline · read-only copies/);
  assert.match(nav, /data-network-status-announcer/);
  assert.doesNotMatch(lock, /This little corner of the internet is private\./);
  assert.doesNotMatch(lock, />Online|data-network-status/);
  assert.match(lock, /class="lock-install" data-pwa-controls/);
  assert.match(lock, /data-install-app>Install Now/);
  assert.match(lock, /passcode__submit visually-hidden/);
  assert.match(lock, /Five incorrect attempts pause entry for 15 minutes/);
  const styles = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'style.css'),
    'utf8',
  );
  assert.match(styles, /\.lock-screen\s*\{[\s\S]*height:\s*100dvh/);
  assert.match(styles, /\.lock-screen\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(styles, /\.lock-install\s*\{[\s\S]*position:\s*relative/);
  assert.match(
    styles,
    /@media \(max-height: 430px\)[\s\S]*grid-template-columns: repeat\(3, 44px\)/,
  );
});

test('landing page exposes the complete feature set and corrected Bucket List label', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'views', 'index.ejs'), 'utf8');
  assert.match(index, /What's Inside/);
  assert.match(index, /Bucket List progress/);
  assert.doesNotMatch(index, /Bucket progress/);
  assert.equal((index.match(/class="feature-card"/g) || []).length, 6);
  assert.match(index, /settings\.partner_one_name/);
  assert.match(index, /anniversaryDisplay/);
  assert.match(index, /src="\/media\/home-photo" data-private-media/);
  assert.doesNotMatch(index, /photo-[1-5]\.svg/);
  assert.doesNotMatch(index, /Together since December 8, 2025/);
});

test('appearance settings provide persistent light, dark, and device themes', () => {
  const settings = fs.readFileSync(
    path.join(__dirname, '..', 'views', 'settings.ejs'),
    'utf8',
  );
  const theme = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'theme.js'),
    'utf8',
  );
  const styles = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'style.css'),
    'utf8',
  );
  assert.match(settings, /value="system".*Use device setting/s);
  assert.match(settings, /value="dark">Dark/);
  assert.match(settings, /data-reduce-motion/);
  assert.match(theme, /gbagl-theme/);
  assert.match(styles, /:root\[data-theme='dark'\]/);
});
