const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { getPool, isDbAvailable } = require('../db');

const BACKUP_PATTERN = /^gbagl-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.zip$/;
const TABLES = ['date_ideas', 'site_settings', 'timeline_milestones'];
const SCHEMA_VERSION = 1;

function backupFilename(date = new Date()) {
  return `gbagl-backup-${date.toISOString().replace(/:/g, '-')}.zip`;
}

function resolveBackupPath(backupDir, filename) {
  if (typeof filename !== 'string' || !BACKUP_PATTERN.test(filename)) {
    throw new Error('Invalid backup filename');
  }
  const root = path.resolve(backupDir);
  const target = path.resolve(root, filename);
  if (path.dirname(target) !== root) throw new Error('Invalid backup path');
  return target;
}

function createBackupService(config) {
  async function list() {
    await fs.promises.mkdir(config.backupDir, { recursive: true });
    const entries = await fs.promises.readdir(config.backupDir, { withFileTypes: true });
    const backups = await Promise.all(entries
      .filter((entry) => entry.isFile() && BACKUP_PATTERN.test(entry.name))
      .map(async (entry) => {
        const fullPath = resolveBackupPath(config.backupDir, entry.name);
        const stat = await fs.promises.stat(fullPath);
        return { name: entry.name, size: stat.size, createdAt: stat.mtime };
      }));
    return backups.sort((left, right) => right.createdAt - left.createdAt);
  }

  async function rotate() {
    const backups = await list();
    for (const backup of backups.slice(config.backupRetention)) {
      await fs.promises.unlink(resolveBackupPath(config.backupDir, backup.name));
    }
  }

  async function create() {
    if (!isDbAvailable()) throw new Error('Database is unavailable; backup was not created');
    await fs.promises.mkdir(config.backupDir, { recursive: true });

    const createdAt = new Date();
    const filename = backupFilename(createdAt);
    const finalPath = resolveBackupPath(config.backupDir, filename);
    const temporaryPath = `${finalPath}.tmp`;
    const tableData = {};
    for (const table of TABLES) {
      const [rows] = await getPool().query(`SELECT * FROM \`${table}\``);
      tableData[table] = rows;
    }

    try {
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(temporaryPath, { flags: 'wx' });
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        archive.append(JSON.stringify({
          createdAt: createdAt.toISOString(),
          schemaVersion: SCHEMA_VERSION,
          tables: TABLES,
        }, null, 2), { name: 'manifest.json' });

        for (const table of TABLES) {
          archive.append(JSON.stringify(tableData[table], null, 2), {
            name: `database/${table}.json`,
          });
        }
        for (const mediaPath of config.backupMediaPaths) {
          if (fs.existsSync(mediaPath)) {
            archive.directory(mediaPath, `media/${path.basename(mediaPath)}`);
          }
        }
        archive.finalize();
      });

      await fs.promises.rename(temporaryPath, finalPath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true });
      await fs.promises.rm(finalPath, { force: true });
      throw error;
    }

    try {
      await rotate();
    } catch (error) {
      console.error('Backup rotation failed:', error.message);
    }
    return { filename, path: finalPath };
  }

  function downloadPath(filename) {
    return resolveBackupPath(config.backupDir, filename);
  }

  return { create, downloadPath, list };
}

function scheduleBackups(service, intervalHours) {
  const run = async () => {
    try {
      const backup = await service.create();
      console.log(`Backup created: ${backup.filename}`);
    } catch (error) {
      console.error('Backup failed:', error.message);
    }
  };
  run();
  const timer = setInterval(run, intervalHours * 60 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = {
  BACKUP_PATTERN,
  SCHEMA_VERSION,
  TABLES,
  backupFilename,
  createBackupService,
  resolveBackupPath,
  scheduleBackups,
};
