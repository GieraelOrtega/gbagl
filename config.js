const path = require('path');

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const MAX_BACKUP_INTERVAL_HOURS = Math.floor(MAX_TIMER_DELAY_MS / (60 * 60 * 1000));
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function pathsOverlap(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  const normalizedLeft = process.platform === 'win32'
    ? resolvedLeft.toLowerCase()
    : resolvedLeft;
  const normalizedRight = process.platform === 'win32'
    ? resolvedRight.toLowerCase()
    : resolvedRight;
  const relative = path.relative(normalizedLeft, normalizedRight);
  const rightWithinLeft = relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  if (rightWithinLeft) return true;

  const reverseRelative = path.relative(normalizedRight, normalizedLeft);
  return reverseRelative === ''
    || (
      !reverseRelative.startsWith(`..${path.sep}`)
      && reverseRelative !== '..'
      && !path.isAbsolute(reverseRelative)
    );
}

function pathContains(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const normalizedParent = process.platform === 'win32'
    ? resolvedParent.toLowerCase()
    : resolvedParent;
  const normalizedChild = process.platform === 'win32'
    ? resolvedChild.toLowerCase()
    : resolvedChild;
  const relative = path.relative(normalizedParent, normalizedChild);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertBackupPathsSeparated(backupDir, mediaPaths) {
  const overlap = mediaPaths.find((mediaPath) => pathsOverlap(backupDir, mediaPath));
  if (overlap) {
    throw new Error(
      `BACKUP_MEDIA_PATHS must not contain or be contained by BACKUP_DIR: ${overlap}`,
    );
  }
}

function required(env, name, aliases = []) {
  const key = [name, ...aliases].find((candidate) => env[candidate]);
  const value = key ? env[key].trim() : '';
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value);
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function assertMinimum(value, minimum, name) {
  if (value.length < minimum) {
    throw new Error(`${name} must be at least ${minimum} characters`);
  }
}

function assertProductionStrength(value, name) {
  const normalized = value.toLowerCase();
  const weakWords = ['admin', 'changeme', 'password', 'passcode', 'replace', 'secret'];
  const repeated = new Set(value).size < 4;
  if (repeated || weakWords.some((word) => normalized.includes(word))) {
    throw new Error(`${name} is too weak for production`);
  }
}

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const sitePasscode = required(env, 'SITE_PASSCODE');
  const cookieSecret = required(env, 'COOKIE_SECRET', ['PASSCODE_COOKIE_SECRET']);
  const adminPassword = required(env, 'ADMIN_PASSWORD', ['ADMIN_SECRET']);

  if (!/^\d{4}$/.test(sitePasscode)) {
    throw new Error('SITE_PASSCODE must be exactly four digits');
  }
  assertMinimum(cookieSecret, production ? 32 : 16, 'COOKIE_SECRET');
  assertMinimum(adminPassword, production ? 12 : 8, 'ADMIN_PASSWORD');

  if (production && sitePasscode === adminPassword) {
    throw new Error('SITE_PASSCODE and ADMIN_PASSWORD must be different');
  }
  if (production) {
    assertProductionStrength(sitePasscode, 'SITE_PASSCODE');
    assertProductionStrength(cookieSecret, 'COOKIE_SECRET');
    assertProductionStrength(adminPassword, 'ADMIN_PASSWORD');
  }

  const root = __dirname;
  const backupDir = path.resolve(env.BACKUP_DIR || path.join(root, 'runtime', 'backups'));
  const uploadDir = path.resolve(env.UPLOAD_DIR || path.join(root, 'runtime', 'uploads'));
  const publicDir = path.join(root, 'public');
  if (pathContains(publicDir, backupDir)) {
    throw new Error('BACKUP_DIR must be outside public/');
  }
  if (pathContains(publicDir, uploadDir)) {
    throw new Error('UPLOAD_DIR must be outside public/');
  }

  const backupIntervalHours = positiveInteger(
    env.BACKUP_INTERVAL_HOURS,
    24,
    'BACKUP_INTERVAL_HOURS',
  );
  if (backupIntervalHours > MAX_BACKUP_INTERVAL_HOURS) {
    throw new Error(
      `BACKUP_INTERVAL_HOURS must not exceed ${MAX_BACKUP_INTERVAL_HOURS}`,
    );
  }
  const configuredMediaPaths = (env.BACKUP_MEDIA_PATHS || 'public/images,runtime/uploads')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(root, item));
  const backupMediaPaths = configuredMediaPaths.some(
    (mediaPath) => pathContains(mediaPath, uploadDir),
  )
    ? configuredMediaPaths
    : [...configuredMediaPaths, uploadDir];
  assertBackupPathsSeparated(backupDir, backupMediaPaths);
  const uploadMaxBytes = positiveInteger(
    env.UPLOAD_MAX_BYTES,
    8 * 1024 * 1024,
    'UPLOAD_MAX_BYTES',
  );
  if (uploadMaxBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`UPLOAD_MAX_BYTES must not exceed ${MAX_UPLOAD_BYTES}`);
  }

  return Object.freeze({
    production,
    port: positiveInteger(env.PORT, 3000, 'PORT'),
    sitePasscode,
    cookieSecret,
    adminPassword,
    adminCookieHours: positiveInteger(env.ADMIN_COOKIE_HOURS, 12, 'ADMIN_COOKIE_HOURS'),
    backupDir,
    publicDir,
    backupRetention: positiveInteger(env.BACKUP_RETENTION, 7, 'BACKUP_RETENTION'),
    backupIntervalHours,
    backupMediaPaths,
    uploadDir,
    uploadMaxBytes,
  });
}

module.exports = {
  MAX_BACKUP_INTERVAL_HOURS,
  MAX_TIMER_DELAY_MS,
  MAX_UPLOAD_BYTES,
  assertBackupPathsSeparated,
  loadConfig,
  pathsOverlap,
  pathContains,
  positiveInteger,
};
