# GBAGL — Gunna Be a Great Life

GBAGL is a private, mobile-friendly relationship site built with Node.js, Express, EJS, and MySQL. It includes a site-wide passcode lock, a separately authenticated admin area, a date-idea planner, an editable timeline, and rotating backups.

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

- `SITE_PASSCODE`
- `ADMIN_PASSWORD` (or the legacy `ADMIN_SECRET` alias), at least 12 characters
- `COOKIE_SECRET` (or the legacy `PASSCODE_COOKIE_SECRET` alias), at least 32 characters

The site passcode and admin password must be different. Authentication comparisons are timing-safe. Cookies are signed, `HttpOnly`, `Secure` in production, and `SameSite=Strict`.

The site lock protects all content and static media. `POST /lock` clears both site and admin authentication; it intentionally uses POST because locking changes authentication state. Admin access requires a second sign-in at `/admin/login`; unlocking the site never grants admin access. Login attempts are rate-limited.

All HTML form writes use CSRF tokens. Missing or invalid tokens receive an explicit `403` response. Security headers, no-store responses, and noindex protections apply to private pages.

## Database and migrations

Configure `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`. On startup the app idempotently creates these application-owned tables:

- `date_ideas`
- `site_settings`
- `timeline_milestones`

If `timeline_milestones` is empty, startup imports the current `data/timeline.js` array once. This preserves deployment-only customized timeline data: a deployment can merge this code and its private `data/timeline.js`, then initialize that exact data without copying it into GitHub. Once rows exist, startup never overwrites them.

The timeline reads ordered database milestones and falls back to `data/timeline.js` if MySQL is unavailable. The admin dashboard manages partner display names, anniversary date, timezone, timeline milestones, and existing date ideas. SQL writes are parameterized and inputs are validated server-side.

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
```

The default backup directory is outside `public/` and ignored by Git. Keep any custom `BACKUP_DIR` outside web-accessible static paths and include it in host-level storage backups. Seven archives are retained by default. Admins can list, download, and manually trigger backups from `/admin`; filenames are allowlisted to prevent path traversal.

Backups are application-level JSON/ZIP snapshots, not transaction-consistent MySQL server snapshots. Media is included only when available to the Node process. Test restore procedures separately before relying on backups for disaster recovery.

## Routes

| Route | Access | Purpose |
|---|---|---|
| `/` | Site passcode | Home |
| `/adventure` | Site passcode | Date-idea planner |
| `/timeline` | Site passcode | Relationship timeline |
| `/admin/login` | Site passcode | Separate admin sign-in |
| `/admin` | Site passcode + admin | Settings, timeline, ideas, and backups |
| `POST /lock` | Site passcode + CSRF | Clear site and admin cookies |

## Private deployment data

The public repository intentionally contains placeholders rather than personal photos or customized timeline entries. Keep deployment-only media and data in the private deployment commit. Existing compatible paths such as `public/images` and `data/timeline.js` remain supported.

Do not commit `.env`, runtime uploads, backup archives, database exports, or private media. This project does not automatically upload backups off-host.

## Validation

```bash
npm test
```

The test suite uses Node's built-in test runner and covers configuration, signed-cookie authentication, CSRF/path validation, and key lock/admin HTTP behavior.
