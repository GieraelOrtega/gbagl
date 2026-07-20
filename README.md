# GBAGL — Gunna Be a Great Life

GBAGL is a private, mobile-friendly relationship site built with Node.js, Express, EJS, and MySQL. It includes a site-wide passcode lock, separate admin authentication, a shared bucket list, anniversary dashboard, events and browser reminders, protected photo albums, a timeline-linked journal, a date-idea planner, and rotating backups.

## Local development

Requirements:

- Node.js 20 or newer
- MySQL when testing database-backed features (the site still renders with DB features disabled when MySQL is unavailable)

```bash
npm install
cp .env.example .env
```

Fill in every authentication value in `.env`; no passcode or password is tracked in Git:

```env
SITE_PASSCODE=<your-local-site-passcode>
ADMIN_PASSWORD=<your-local-admin-passphrase>
COOKIE_SECRET=<your-stable-random-signing-secret>
```

`COOKIE_SECRET` signs site, admin, and CSRF cookies and must remain stable across restarts. Start the app with `npm start`, or use `npm run dev` for automatic restarts.

## Production requirements

Production startup fails clearly unless all of the following are present and sufficiently strong:

- `SITE_PASSCODE`, exactly four digits
- `ADMIN_PASSWORD` (or the legacy `ADMIN_SECRET` alias), at least 12 characters
- `COOKIE_SECRET` (or the legacy `PASSCODE_COOKIE_SECRET` alias), at least 32 characters

The site passcode and admin password must be different. `BACKUP_INTERVAL_HOURS` must be between 1 and 596 so it remains within Node's safe timer range. Authentication comparisons are timing-safe. Cookies are signed, `HttpOnly`, `Secure` in production, and `SameSite=Strict`.

The site lock protects all content and static media. `POST /lock` clears both site and admin authentication; it intentionally uses POST because locking changes authentication state. Admin access requires a second sign-in at `/admin/login`; unlocking the site never grants admin access. Login attempts are rate-limited.

All HTML form writes use CSRF tokens. Missing or invalid tokens receive an explicit `403` response. Security headers, no-store responses, and noindex protections apply to private pages.

## Database and migrations

Configure `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`. On startup the app idempotently creates these application-owned tables:

- `date_ideas`
- `site_settings`
- `timeline_milestones`
- `bucket_items`
- `bucket_votes`
- `shared_events`
- `photo_albums`
- `album_photos`
- `journal_entries`

On the first migration, startup imports the current `data/timeline.js` array if `timeline_milestones` is empty, then records a durable completion marker in `site_settings`. This preserves deployment-only customized timeline data: a deployment can merge this code and its private `data/timeline.js`, then initialize that exact data without copying it into GitHub. Once migration completes, startup never reimports, even when an admin intentionally deletes every milestone.

The timeline reads ordered database milestones and falls back to `data/timeline.js` if MySQL is unavailable. Journal and other Layer 2 pages report database outages explicitly instead of fabricating data. The admin dashboard manages partner display names, anniversary date, timezone, timeline milestones, and existing date ideas, with separate pages for Layer 2 records. SQL writes are parameterized and inputs are validated server-side.

The anniversary date may be left unset; the home page does not invent one. Leap-day anniversaries use February 28 in non-leap years. Event times are entered in the configured IANA timezone and stored as UTC.

## Albums and reminders

New album uploads are written under `UPLOAD_DIR` (default `runtime/uploads`) and are never exposed by static middleware. The admin upload accepts only JPEG, PNG, or WebP, enforces `UPLOAD_MAX_BYTES`, checks file signatures, assigns random storage names, and cleans rejected files. Album views retrieve media through authenticated, ID-based routes with private no-store and `nosniff` headers.

Deployment-local images already under `public/images` can be linked by an explicit `/images/<basename>` reference. The application does not enumerate that directory. Keep private deployment images out of GitHub.

Browser reminder permission is requested only from the **Enable browser reminders** button. Alerts are checked while GBAGL remains open; there is no background push delivery in Layer 2. Each event also has an ICS download for a device calendar. The authenticated, no-store JSON feed exposes only due reminder IDs, titles, times, and site URLs and is shaped for a later Layer 3 service worker.

## Backups

After database initialization, the app attempts a backup and repeats every 24 hours by default. Backup failures are logged and do not crash the site. Each ZIP contains:

- `manifest.json` with timestamp and schema version
- JSON exports of all application-owned tables
- files under configured media paths when those paths exist

Defaults:

```env
BACKUP_DIR=runtime/backups
BACKUP_RETENTION=7
BACKUP_INTERVAL_HOURS=24
BACKUP_MEDIA_PATHS=public/images,runtime/uploads
UPLOAD_DIR=runtime/uploads
UPLOAD_MAX_BYTES=8388608
```

The default backup directory is outside `public/` and ignored by Git. Keep any custom `BACKUP_DIR` outside web-accessible static paths and include it in host-level storage backups. A custom `UPLOAD_DIR` is automatically added to the backup media roots when it is not already covered. Seven archives are retained by default. Admins can list, download, and manually trigger backups from `/admin`; filenames are allowlisted to prevent path traversal.

`BACKUP_MEDIA_PATHS` must not contain or be contained by `BACKUP_DIR`. Startup rejects lexical overlap, and backup creation verifies real paths before opening an archive so symlink aliases cannot recursively include backup output.

Backups use one repeatable-read MySQL snapshot for all exported tables, preserve database dates as raw UTC strings, and serialize in-process photo mutations while media is archived, keeping application rows and runtime uploads aligned. They remain application-level JSON/ZIP exports rather than MySQL-native physical backups, and cannot coordinate with out-of-process changes to media files. Test restore procedures separately before relying on backups for disaster recovery.

## Routes

| Route | Access | Purpose |
|---|---|---|
| `/` | Site passcode | Home |
| `/adventure` | Site passcode | Date-idea planner |
| `/timeline` | Site passcode | Relationship timeline |
| `/bucket` | Site passcode | Shared bucket list, votes, completion, and memories |
| `/reminders` | Site passcode | Upcoming/past events, browser reminders, and ICS files |
| `/reminders/feed.json` | Site passcode | Minimal no-store due-reminder feed |
| `/albums` | Site passcode | Protected album gallery |
| `/albums/photos/:id/content` | Site passcode | ID-based private photo response |
| `/journal` | Site passcode | Shared journal |
| `/admin/login` | Site passcode | Separate admin sign-in |
| `/admin` | Site passcode + admin | Settings, timeline, ideas, backups, and Layer 2 admin links |
| `/admin/bucket` | Site passcode + admin | Bucket-item CRUD |
| `/admin/events` | Site passcode + admin | Event/reminder CRUD |
| `/admin/albums` | Site passcode + admin | Album/photo CRUD, uploads, references, and ordering |
| `/admin/journals` | Site passcode + admin | Journal CRUD |
| `POST /lock` | Site passcode + CSRF | Clear site and admin cookies |

## Private deployment data

The public repository intentionally contains placeholders rather than personal photos or customized timeline entries. Keep deployment-only media and data in the private deployment commit. Existing compatible paths such as `public/images` and `data/timeline.js` remain supported.

Do not commit `.env`, runtime uploads, backup archives, database exports, or private media. This project does not automatically upload backups off-host.

## Validation

```bash
npm test
```

The test suite uses Node's built-in test runner and covers configuration, signed-cookie authentication, CSRF/path validation, countdown/leap-day behavior, upload magic/path validation and cleanup, vote toggling, ICS formatting, and key lock/admin/feature HTTP behavior.
