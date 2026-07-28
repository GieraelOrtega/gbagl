# GBAGL — Gunna Be a Great Life

GBAGL is a private, installable relationship site built with Node.js, Express, EJS, and MySQL. Its five content destinations are Home, Timeline, Bucket List, Adventure, and Journal. It includes a read-only passcode viewer, named member/administrator accounts, privacy-aware offline viewing, shared events, protected Timeline and Journal photos, keepsake exports, rotating backups, and device-local light/dark appearance settings.

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
GIERAEL_PASSWORD=<your-local-Gierael-password>
KIM_PASSWORD=<your-local-Kim-password>
COOKIE_SECRET=<your-stable-random-signing-secret>
PUBLIC_ORIGIN=https://gba.gl
TRUST_PROXY=loopback
```

`COOKIE_SECRET` signs site, account, and CSRF cookies and must remain stable across restarts. The account passwords are web-app deployment secrets, so configure them in the host environment rather than Windows Credential Manager. Start the app with `npm start`, or use `npm run dev` for automatic restarts.

## Production requirements

Production startup fails clearly unless all of the following are present and sufficiently strong:

- `SITE_PASSCODE`, exactly four digits
- `GIERAEL_PASSWORD`, at least 12 characters (`ADMIN_PASSWORD` and `ADMIN_SECRET` remain legacy aliases)
- `KIM_PASSWORD`, at least 12 characters
- `COOKIE_SECRET` (or the legacy `PASSCODE_COOKIE_SECRET` alias), at least 32 characters
- `PUBLIC_ORIGIN`, an HTTPS origin with no path (defaults to `https://gba.gl`)
- `TRUST_PROXY`, `loopback` and/or comma-separated exact reverse-proxy IP addresses

The site passcode and both account passwords must be different, and the two account passwords cannot be shared. `BACKUP_INTERVAL_HOURS` must be between 1 and 596 so it remains within Node's safe timer range. Authentication comparisons are timing-safe. Production redirects insecure requests to `PUBLIC_ORIGIN` before parsing request bodies or serving authentication forms. Only exact configured proxy addresses can supply trusted forwarding headers, preventing direct clients from spoofing HTTPS or rate-limit identities. Cookies are signed, `HttpOnly`, `Secure` in production, and `SameSite=Strict`.

The site lock protects all content and static media. Unlocking with `SITE_PASSCODE` grants read-only viewer access. Gierael and Kim sign in separately from Settings: Kim can manage shared content, while Gierael can also change site configuration, create/download backups, and generate exports. Every write is checked server-side; hiding controls is not the authorization boundary. The passcode screen shows the current failed-attempt count and a live timeout after five failures.

`POST /lock` remains the authenticated revocation endpoint and clears both site and account cookies plus private browser data. It is intentionally a POST, but the former main-navigation **Lock Now** control has been removed.

All HTML form writes use CSRF tokens. Missing or invalid tokens receive an explicit `403` response. Security headers, no-store responses, and noindex protections apply to private pages.

## Database and migrations

Configure the app-scoped `GBAGL_DB_USER`, `GBAGL_DB_PASSWORD`, and `GBAGL_DB_NAME`, plus either `GBAGL_DB_SOCKET` or the TCP settings `GBAGL_DB_HOST` and `GBAGL_DB_PORT`. Each app-scoped key takes precedence when it is defined, including an explicitly empty password. The generic `DB_*` names remain supported when their corresponding app-scoped keys are absent.

Gandi Simple Hosting exposes MySQL through a Unix socket rather than TCP and may inject unrelated generic `DB_USER` and `DB_PASSWORD` values. Use the app-scoped names to avoid those platform collisions:

```env
GBAGL_DB_HOST=localhost
GBAGL_DB_PORT=0
GBAGL_DB_SOCKET=/srv/run/mysqld/mysqld.sock
GBAGL_DB_USER=root
GBAGL_DB_PASSWORD=
GBAGL_DB_NAME=default_db
```

With a nonblank `GBAGL_DB_SOCKET`, host and port are omitted from the MySQL connection. Defining `GBAGL_DB_SOCKET=` as blank intentionally selects the existing TCP fallback instead of a generic `DB_SOCKET`. Keep the empty password only when using Gandi's local socket defaults; use the credentials supplied by the host if they have been changed. On startup the app idempotently creates these application-owned tables:

- `date_ideas`
- `site_settings`
- `timeline_milestones`
- `bucket_items`
- `bucket_votes`
- `shared_events`
- `photo_albums`
- `album_photos`
- `journal_entries`

On the first migration, startup imports the current `data/timeline.js` array if `timeline_milestones` is empty, then records a durable completion marker in `site_settings`. This preserves deployment-only customized timeline data: a deployment can merge this code and its private `data/timeline.js`, then initialize that exact data without copying it into GitHub. Once migration completes, startup never reimports, even when a member intentionally deletes every milestone.

The initial placeholder settings are Gierael, Kim, and the December 8, 2025 anniversary. A durable one-time migration upgrades only untouched placeholder/blank values and replaces only the untouched first timeline placeholder with the “Officially Us” milestone. Later customizations—including intentionally clearing the anniversary—survive restarts.

The timeline reads ordered database milestones and falls back to `data/timeline.js` if MySQL is unavailable. Journal and other Layer 2 pages report database outages explicitly instead of fabricating data. Signed-in members add, edit, delete, and reorder content directly on its corresponding page; Timeline edit mode exposes a responsive form for every milestone, including direct add/replace/remove photo controls with no path entry. Settings retains appearance, account, and administrator controls only. SQL writes are parameterized and inputs are validated server-side.

Adventure ideas, milestones, Bucket List items, events, Journal moments, and each moment's photos all have durable `display_order` values. Reorder requests require a member session and CSRF token, validate the complete current ID set, and commit the new sequence in one transaction. Touch drag handles and accessible Up/Down controls use the same endpoint.

The anniversary date may be left unset; the home page does not invent one. Leap-day anniversaries use February 28 in non-leap years. Event times are entered in the configured IANA timezone and stored as UTC.

Existing albums are migrated idempotently into Journal moments on startup. Their protected media rows remain intact and are associated with the new moments, while a hidden system album owns photos uploaded directly to Journal. Legacy album links redirect to the corresponding Journal destination, and the legacy authenticated photo-content URL remains available so existing private media references do not break.

## Timeline and Journal photos, and Adventure events

New Timeline, Journal, and home-photo uploads are written under `UPLOAD_DIR` (default `runtime/uploads`) and are never exposed by static middleware. Signed-in members can upload JPEG, PNG, WebP, HEIC, or HEIF. HEIC/HEIF files are dimension-checked and converted to JPEG before storage. The server enforces `UPLOAD_MAX_BYTES`, validates signatures after upload, assigns random storage names, and cleans rejected or rolled-back files. Timeline replacement, removal, and milestone deletion commit database changes before orphan cleanup; only files explicitly marked as runtime uploads are deleted. Timeline, Journal, and home-hero media use authenticated responses with private no-store, PWA media opt-in, and `nosniff` headers.

Existing deployment-local Timeline paths under `public/images` remain compatible in imported fallback data and existing database rows. They are served through the protected Timeline response when the database is available, are never deleted by photo replacement/removal, and remain directly available to the file fallback during an outage. The application does not enumerate that directory. Keep private deployment images out of GitHub.

Events are created, edited, reordered, and reviewed inside Adventure. Each event has an ICS download for a device calendar; an optional calendar-alert time becomes an ICS alarm. Times continue to use the configured IANA timezone. GBAGL does not request browser-notification permission or expose a reminder feed.

## Installable app and offline privacy

GBAGL exposes a checked-in web-app manifest, GK Apple touch icon, and maskable icons for browser-native installation. The lock screen intentionally has no custom installation control or guidance; installation remains available through supported browser menus. There are no third-party runtime scripts, styles, or fonts.

The versioned service worker keeps two separate caches:

- The public shell contains only the lock/offline stylesheet, scripts, manifest, and icons. It contains no relationship data.
- The private cache accepts only server-opted-in, read-only snapshots of `/`, `/timeline`, `/bucket`, `/adventure`, and `/journal`, plus successfully authorized Timeline, Journal, and home-photo responses. Live HTML with forms or CSRF tokens is never stored.

Settings pages, backup and keepsake downloads, calendar downloads, writes, redirects, cross-origin resources, authorization failures, and arbitrary paths are never cached. Previously viewed private pages can be read offline, but all forms are absent from offline snapshots and live mutation controls disable when the browser goes offline.

Returning to the locked state clears private Cache Storage and legacy reminder state. An authorization loss also purges the private cache. Offline copies otherwise remain on that browser/device until site-data clearing. This is a privacy deterrent, not encrypted storage; anyone with access to that browser profile may be able to read cached copies.

## Keepsake exports

The Gierael-only `/settings/exports` page requires both the site passcode and the administrator account. Kim receives `403` for this area. Export downloads are rate-limited, `no-store`, and fail with an explicit `503` while MySQL is unavailable.

- PDF: partner names, anniversary, timeline, Journal moments and photos, completed bucket memories, shared events, page numbers, and safely readable JPEG/PNG photos. Unsupported WebP and other timeline formats retain a caption/reference and remain available in ZIP.
- ZIP: a self-contained printable `keepsake.html`, deterministic `data.json`, `manifest.json`, and safely resolved Journal/timeline media under generated archive paths.

Each export reads its records in one repeatable-read transaction and holds the existing media coordinator while files are collected. Missing or invalid media is reported without crashing or exposing server paths. Exports never contain database credentials, cookies, authentication secrets, backup archives, temp files, or deployment paths.

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
UPLOAD_MAX_BYTES=20971520
```

The default backup directory is outside `public/` and ignored by Git. Keep any custom `BACKUP_DIR` outside web-accessible static paths and include it in host-level storage backups. A custom `UPLOAD_DIR` is automatically added to the backup media roots when it is not already covered. Seven archives are retained by default. Gierael can list, download, and manually trigger backups from `/settings`; filenames are allowlisted to prevent path traversal.

`BACKUP_MEDIA_PATHS` must not contain or be contained by `BACKUP_DIR`. Startup rejects lexical overlap, and backup creation verifies real paths before opening an archive so symlink aliases cannot recursively include backup output.

Backups use one repeatable-read MySQL snapshot for all exported tables, preserve database dates as raw UTC strings, and serialize in-process photo mutations while media is archived, keeping application rows and runtime uploads aligned. They remain application-level JSON/ZIP exports rather than MySQL-native physical backups, and cannot coordinate with out-of-process changes to media files. Test restore procedures separately before relying on backups for disaster recovery.

## Routes

| Route | Access | Purpose |
|---|---|---|
| `/` | Viewer | Home |
| `/timeline` | Viewer read; member write | Ordered relationship timeline and granular milestone editing |
| `/timeline/photos/:id/content` | Viewer | Protected Timeline milestone photo response |
| `/bucket` | Viewer read; member write | Shared bucket list, votes, completion, and memories |
| `/adventure` | Viewer read; member write | Date ideas, status legend, and upcoming/past events |
| `/media/home-photo` | Viewer | Protected home hero photo |
| `/journal` | Viewer read; member write | Ordered moments, notes, and protected photos |
| `/albums/photos/:id/content` | Viewer | Legacy-compatible private Journal photo response |
| `/settings/login` | Viewer | Gierael/Kim account sign-in |
| `/settings` | Member | Appearance, account details, and links to in-page content editors |
| `/settings/exports` | Gierael only | Sensitive PDF and portable ZIP keepsake downloads |
| `POST /settings/site` | Gierael only | Partner names, anniversary, and timezone |
| `/settings/backups/*` | Gierael only | Backup creation and downloads |
| `POST /lock` | Viewer + CSRF | Clear site and account cookies |

## Private deployment data

The public repository intentionally contains placeholders rather than personal photos or customized timeline entries. Runtime uploads—including Timeline and home hero photos—remain outside Git. Keep other deployment-only media and timeline data in the private deployment commit. Existing compatible paths such as `public/images` and `data/timeline.js` remain supported.

Do not commit `.env`, runtime uploads, backup archives, database exports, or private media. This project does not automatically upload backups off-host.

## Validation

```bash
npm test
```

The test suite uses Node's built-in test runner and covers configuration, viewer/member/administrator authorization, signed cookies, CSRF/path validation, countdown/leap-day behavior, album migration, Timeline and Journal JPEG/PNG/WebP/HEIC upload validation and cleanup, legacy Timeline photo preservation, protected media responses, responsive editor containment, vote toggling, ICS formatting, cache policy and lock clearing, export authorization and transaction cleanup, ZIP safety/content, PDF output, and key lock/settings/feature HTTP behavior.
