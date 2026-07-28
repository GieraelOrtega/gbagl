const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('every standard page has a keyboard skip target', () => {
  assert.match(read('views/partials/head.ejs'), /class="skip-link" href="#main-content"/);
  [
    '404.ejs',
    'adventure.ejs',
    'album.ejs',
    'albums.ejs',
    'bucket.ejs',
    'error.ejs',
    'index.ejs',
    'journal.ejs',
    'reminders.ejs',
    'settings-exports.ejs',
    'settings-login.ejs',
    'settings.ejs',
    'timeline.ejs',
  ].forEach((template) => {
    assert.match(
      read(`views/${template}`),
      /<main[^>]*id="main-content"[^>]*tabindex="-1"[^>]*>/,
      `${template} is missing the skip-link target`,
    );
  });
});

test('navigation identifies the current page and supports closing without a pointer', async () => {
  const nav = read('views/partials/nav.ejs');
  const client = read('public/js/main.js');
  const styles = read('public/css/style.css');
  const renderedNav = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'partials', 'nav.ejs'),
    { currentUser: null, offlineSnapshot: false, page: 'home' },
  );

  assert.match(nav, /<nav class="nav" aria-label="Primary">/);
  assert.equal((renderedNav.match(/aria-current="page"/g) || []).length, 1);
  assert.match(renderedNav, /href="\/" class="nav__link nav__link--active"[\s\S]*aria-current="page"/);
  assert.match(client, /event\.key === 'Escape'/);
  assert.match(client, /Close navigation/);
  assert.match(client, /!nav\.contains\(event\.target\)/);
  assert.match(client, /!nav\.contains\(document\.activeElement\)/);
  assert.match(styles, /max-height: calc\(100dvh - 64px\)/);
  assert.match(styles, /\.nav__link\s*\{[\s\S]*min-height: 44px/);
});

test('feedback remains controllable and urgent messages do not time out', () => {
  const client = read('public/js/main.js');
  assert.match(client, /dismiss\.textContent = 'Dismiss'/);
  assert.match(client, /if \(!alert\.classList\.contains\('alert--success'\)\) return/);
  assert.match(client, /window\.setTimeout\(removeAlert, 8000\)/);
  assert.match(client, /alert\.setAttribute\('role', isUrgent \? 'alert' : 'status'\)/);
});
