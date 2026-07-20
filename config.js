const path = require('path');

function required(env, name, aliases = []) {
  const key = [name, ...aliases].find((candidate) => env[candidate]);
  const value = key ? env[key].trim() : '';
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
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

  assertMinimum(sitePasscode, 4, 'SITE_PASSCODE');
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
  const publicDir = path.join(root, 'public');
  if (backupDir === publicDir || backupDir.startsWith(`${publicDir}${path.sep}`)) {
    throw new Error('BACKUP_DIR must be outside public/');
  }

  return Object.freeze({
    production,
    port: positiveInteger(env.PORT, 3000, 'PORT'),
    sitePasscode,
    cookieSecret,
    adminPassword,
    adminCookieHours: positiveInteger(env.ADMIN_COOKIE_HOURS, 12, 'ADMIN_COOKIE_HOURS'),
    backupDir,
    backupRetention: positiveInteger(env.BACKUP_RETENTION, 7, 'BACKUP_RETENTION'),
    backupIntervalHours: positiveInteger(
      env.BACKUP_INTERVAL_HOURS,
      24,
      'BACKUP_INTERVAL_HOURS',
    ),
    backupMediaPaths: (env.BACKUP_MEDIA_PATHS || 'public/images,runtime/uploads')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(root, item)),
  });
}

module.exports = { loadConfig, positiveInteger };
