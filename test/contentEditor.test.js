const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { formatDate } = require('../lib/presentation');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('content forms live on their corresponding pages instead of Settings', () => {
  const expectations = new Map([
    ['views/adventure.ejs', ['/adventure', '/adventure/<%= idea.id %>']],
    ['views/partials/events-section.ejs', ['/reminders', '/reminders/<%= event.id %>']],
    ['views/timeline.ejs', ['/timeline', '/timeline/<%= milestone.id %>']],
    ['views/bucket.ejs', ['/bucket']],
    ['views/partials/bucket-card.ejs', ['/bucket/<%= item.id %>']],
    ['views/journal.ejs', [
      '/journal',
      '/journal/<%= entry.id %>',
      '/journal/<%= entry.id %>/photos',
    ]],
  ]);
  for (const [file, actions] of expectations) {
    const source = read(file);
    assert.match(source, /if \([^)]*canEdit/);
    actions.forEach((action) => assert.ok(source.includes(`action="${action}`), `${file} missing ${action}`));
  }

  const settings = read('views/settings.ejs');
  assert.doesNotMatch(settings, /action="\/settings\/(?:content|timeline|ideas)/);
  assert.match(settings, /Adding, editing, and reordering now happens directly on each page/);
});

test('every ordered content surface exposes protected reorder metadata', () => {
  const views = [
    ['views/adventure.ejs', '/adventure/reorder'],
    ['views/partials/events-section.ejs', '/reminders/reorder'],
    ['views/timeline.ejs', '/timeline/reorder'],
    ['views/bucket.ejs', '/bucket/reorder', 'views/partials/bucket-card.ejs'],
    ['views/journal.ejs', '/journal/reorder'],
    ['views/journal.ejs', '/photos/reorder'],
  ];
  views.forEach(([file, endpoint, itemFile]) => {
    const source = `${read(file)}${itemFile ? read(itemFile) : ''}`;
    assert.match(source, /data-reorder-item/);
    assert.ok(source.includes(endpoint), `${file} missing ${endpoint}`);
  });

  const client = read('public/js/contentEditor.js');
  assert.match(client, /pointerdown/);
  assert.match(client, /data-move-direction/);
  assert.match(client, /Content-Type': 'application\/json/);
  assert.match(client, /_csrf: csrfToken/);
  assert.match(client, /position \$\{items\.indexOf\(item\) \+ 1\} of \$\{items\.length\}/);
  assert.match(client, /Reordering enabled\. Drag items or use Up and Down/);
  assert.match(client, /event\.key !== 'Escape'/);
  assert.match(client, /cancelActiveDrag\(\)/);
  assert.match(client, /data-reorder-busy/);
  assert.match(client, /data-reorder-boundary/);
  assert.match(client, /function submittedItems\(group, list\)/);
  assert.match(client, /list\.dataset\.reorderSubmit === 'list'/);
  assert.match(client, /\.then\(\(saved\) =>/);
  assert.doesNotMatch(client, /control\.disabled = busy/);
  assert.doesNotMatch(client, /up\.disabled = index/);
});

test('timeline edit mode exposes granular forms for every milestone', () => {
  const timeline = read('views/timeline.ejs');
  assert.match(timeline, /data-timeline-edit-toggle/);
  assert.match(timeline, /data-timeline-edit-controls/);
  assert.match(timeline, /aria-controls="timeline-edit-controls"/);
  assert.match(timeline, /action="\/timeline\/<%= milestone.id %>"/);
  assert.match(timeline, /partials\/milestone-fields/);
  assert.doesNotMatch(read('views/partials/milestone-fields.ejs'), /name="display_order"/);
});

test('editable page templates render with representative content', async () => {
  const base = {
    title: 'Test',
    page: '',
    currentUser: { displayName: 'Gierael', role: 'admin' },
    canEdit: true,
    isAdmin: true,
    offlineSnapshot: false,
    csrfToken: 'csrf-token',
    message: null,
    error: null,
    dbError: null,
  };
  const fixtures = new Map([
    ['adventure.ejs', {
      ...base,
      page: 'adventure',
      ideas: [{
        id: 1, vibe: 'cozy', budget: '$', location: 'at home', notes: 'Tea',
        status: 'pending', created_at_display: 'Today',
      }],
      suggestedIdeas: [],
      validVibes: ['cozy'],
      validBudgets: ['$'],
      validLocations: ['at home'],
      upcoming: [{
        id: 2, title: 'Dinner', event_at: '2026-08-01T01:00:00Z',
        reminder_at: null, event_input: '2026-07-31T18:00',
        reminder_input: '', notes: 'Reservation', is_completed: 0,
      }],
      past: [],
      timeZone: 'UTC',
      formatDateTime: (value) => value,
    }],
    ['timeline.ejs', {
      ...base,
      page: 'timeline',
      milestones: [{
        id: 1, date: 'Today', title: 'A milestone', description: 'Story',
        emoji: 'X', photo: null, link_url: null,
      }],
      journals: [],
      journalError: null,
      timelineDegraded: false,
      editMode: true,
    }],
    ['bucket.ejs', {
      ...base,
      page: 'bucket',
      activeItems: [
        {
          id: 1, title: 'A dream', description: 'Go somewhere', category: 'travel',
          target_date: null, is_favorite: 0, completed_at: null, memory: null,
          partner_one_vote: null, partner_two_vote: null,
        },
        {
          id: 2, title: 'Another dream', description: 'Try something', category: 'food',
          target_date: '2026-09-01', is_favorite: 1, completed_at: null, memory: null,
          partner_one_vote: 'yes', partner_two_vote: 'maybe',
        },
      ],
      completedItems: [{
        id: 3, title: 'A memory', description: 'We did it', category: 'experience',
        target_date: null, is_favorite: 1, completed_at: '2026-07-20',
        memory: 'A day to remember', partner_one_vote: 'yes', partner_two_vote: 'yes',
      }],
      formatDate,
      labels: { partner_one: 'Gierael', partner_two: 'Kim' },
      today: '2026-07-27',
    }],
    ['journal.ejs', {
      ...base,
      page: 'journal',
      milestones: [{ id: 1, title: 'A milestone' }],
      entries: [{
        id: 1, milestone_id: 1, milestone_title: 'A milestone',
        title: 'Today', body: 'A reflection', entry_date: '2026-07-20',
        photos: [{
          id: 3, journal_entry_id: 1, caption: 'Us', photo_date: '2026-07-20',
        }],
      }],
    }],
  ]);

  for (const [template, locals] of fixtures) {
    const html = await ejs.renderFile(path.join(__dirname, '..', 'views', template), locals);
    assert.match(html, /data-reorder-item/, `${template} did not render editable content`);
    assert.match(html, /name="_csrf" value="csrf-token"/);
  }
});

test('Bucket List rendering keeps active dreams first and completed controls status-scoped', async () => {
  const locals = {
    title: 'Bucket List',
    page: 'bucket',
    currentUser: { displayName: 'Kim', role: 'member' },
    canEdit: true,
    isAdmin: false,
    offlineSnapshot: false,
    csrfToken: 'csrf-token',
    message: null,
    error: null,
    dbError: null,
    activeItems: [
      {
        id: 1, title: 'First active dream', description: 'First', category: 'travel',
        target_date: null, is_favorite: 0, completed_at: null, memory: null,
        partner_one_vote: null, partner_two_vote: null,
      },
      {
        id: 2, title: 'Second active dream', description: 'Second', category: 'food',
        target_date: '2026-08-01', is_favorite: 1, completed_at: null, memory: null,
        partner_one_vote: 'yes', partner_two_vote: 'maybe',
      },
    ],
    completedItems: [{
      id: 3, title: 'Completed dream', description: 'Done', category: 'experience',
      target_date: null, is_favorite: 0, completed_at: '2026-07-20',
      memory: 'The best afternoon.', partner_one_vote: 'yes', partner_two_vote: 'yes',
    }],
    formatDate,
    labels: { partner_one: 'Gierael', partner_two: 'Kim' },
    today: '2026-07-27',
  };
  const html = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'bucket.ejs'),
    locals,
  );

  assert.ok(html.indexOf('id="active-dreams-heading"') < html.indexOf('id="completed-dreams-heading"'));
  assert.match(html, /aria-label="2 active dreams"/);
  assert.match(html, /aria-label="1 completed dream"/);
  assert.match(html, /data-reorder-group="bucket-active"[\s\S]*data-reorder-submit="list"/);
  assert.match(html, /id="bucket-item-1"[\s\S]*data-reorder-item/);
  const completedCard = html.match(
    /<article[^>]*id="bucket-item-3"[\s\S]*?<\/article>/,
  )?.[0];
  assert.ok(completedCard);
  assert.doesNotMatch(completedCard, /data-reorder-item|data-drag-handle/);
  assert.match(completedCard, /<time datetime="2026-07-20">July 20, 2026<\/time>/);
  assert.match(completedCard, /The best afternoon\./);
  assert.match(html, /name="completed_at"[\s\S]*value="2026-07-27"[\s\S]*required/);
  for (const action of [
    '/favorite',
    '/vote',
    '/completion',
    '/memory',
    '/delete',
  ]) {
    assert.ok(html.includes(action), `Bucket List rendering missing ${action}`);
  }

  const offlineHtml = await ejs.renderFile(
    path.join(__dirname, '..', 'views', 'bucket.ejs'),
    {
      ...locals,
      currentUser: null,
      canEdit: false,
      offlineSnapshot: true,
      csrfToken: null,
    },
  );
  assert.match(offlineHtml, /<body data-offline-snapshot>/);
  assert.match(offlineHtml, /The best afternoon\./);
  assert.doesNotMatch(offlineHtml, /<form|contentEditor\.js/);
});
