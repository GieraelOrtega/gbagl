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
    'bucket.ejs',
    'error.ejs',
    'index.ejs',
    'journal.ejs',
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

test('Bucket List sections and completion forms stay semantic and mobile-contained', () => {
  const bucket = read('views/bucket.ejs');
  const card = read('views/partials/bucket-card.ejs');
  const styles = read('public/css/style.css');

  assert.match(bucket, /aria-labelledby="active-dreams-heading"/);
  assert.match(bucket, /aria-labelledby="completed-dreams-heading"/);
  assert.match(bucket, /aria-label="<%= activeItems\.length %> active/);
  assert.match(bucket, /data-reorder-submit="list"/);
  assert.match(bucket, /include\('partials\/bucket-card', \{ item, reorderable: false \}\)/);
  assert.match(card, /<time datetime="<%= item\.completed_at %>">/);
  assert.match(card, /role="group" aria-label="Votes for/);
  assert.match(card, /aria-labelledby="memory-heading-<%= item\.id %>"/);
  assert.match(card, /aria-describedby="complete-help-<%= item\.id %>"/);
  assert.match(card, /name="completed_at"[\s\S]*value="<%= today %>"[\s\S]*required/);
  assert.match(card, /if \(reorderable\)[\s\S]*data-reorder-item/);
  assert.match(
    styles,
    /\.bucket-card \.form-input,[\s\S]*max-width: 100%;[\s\S]*min-width: 0;/,
  );
  assert.match(
    styles,
    /@media \(max-width: 639px\)[\s\S]*\.bucket-card[\s\S]*padding: var\(--space-lg\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 639px\)[\s\S]*\.bucket-card__favorite-form \.btn,[\s\S]*width: 100%/,
  );
  assert.match(
    styles,
    /\.bucket-section__intro \.section-eyebrow\s*\{[\s\S]*color: var\(--color-text\)/,
  );
  assert.match(
    styles,
    /\.bucket-count\s*\{[\s\S]*color: var\(--color-text\)/,
  );
});
