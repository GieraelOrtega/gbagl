/**
 * db.js — MySQL database connection
 *
 * This module creates a connection pool and applies idempotent
 * application-owned schema migrations.
 */

const mysql = require('mysql2/promise');

// Track whether the DB is up so routes can degrade gracefully
let pool = null;
let dbAvailable = false;
const TIMELINE_IMPORT_MARKER = 'timeline_import_complete';
const RELATIONSHIP_BASICS_MARKER = 'relationship_basics_2025_12_08_v1';
const ORDERED_CONTENT_TABLES = Object.freeze([
  Object.freeze({ table: 'date_ideas', index: 'ideas_order' }),
  Object.freeze({ table: 'bucket_items', index: 'bucket_order' }),
  Object.freeze({ table: 'shared_events', index: 'events_order' }),
  Object.freeze({ table: 'journal_entries', index: 'journal_order' }),
]);

function isConcurrentSchemaDuplicate(error, expectedCode, expectedNumber) {
  return error?.code === expectedCode || Number(error?.errno) === expectedNumber;
}

function selectEnvValue(env, scopedKey, genericKey) {
  return env[scopedKey] !== undefined ? env[scopedKey] : env[genericKey];
}

function buildPoolOptions(env = process.env) {
  const configuredSocket = selectEnvValue(env, 'GBAGL_DB_SOCKET', 'DB_SOCKET');
  const socketPath = typeof configuredSocket === 'string'
    ? configuredSocket.trim()
    : '';
  const connection = socketPath
    ? { socketPath }
    : {
      host: selectEnvValue(env, 'GBAGL_DB_HOST', 'DB_HOST') || 'localhost',
      port: parseInt(selectEnvValue(env, 'GBAGL_DB_PORT', 'DB_PORT') || '3306', 10),
    };

  return {
    ...connection,
    user: selectEnvValue(env, 'GBAGL_DB_USER', 'DB_USER') || 'root',
    password: selectEnvValue(env, 'GBAGL_DB_PASSWORD', 'DB_PASSWORD') ?? '',
    database: selectEnvValue(env, 'GBAGL_DB_NAME', 'DB_NAME') || 'gbagl',
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
    dateStrings: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
  };
}

async function ensureContentOrderingSchema(databasePool = pool) {
  for (const definition of ORDERED_CONTENT_TABLES) {
    const [columnRows] = await databasePool.execute(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = 'display_order'
       LIMIT 1`,
      [definition.table],
    );
    if (columnRows.length === 0) {
      try {
        await databasePool.query(
          `ALTER TABLE ${definition.table}
           ADD COLUMN display_order INT NOT NULL DEFAULT 0`,
        );
      } catch (error) {
        if (!isConcurrentSchemaDuplicate(error, 'ER_DUP_FIELDNAME', 1060)) throw error;
      }
    }

    const [indexRows] = await databasePool.execute(
      `SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND INDEX_NAME = ?
       LIMIT 1`,
      [definition.table, definition.index],
    );
    if (indexRows.length === 0) {
      try {
        await databasePool.query(
          `ALTER TABLE ${definition.table}
           ADD INDEX ${definition.index} (display_order, id)`,
        );
      } catch (error) {
        if (!isConcurrentSchemaDuplicate(error, 'ER_DUP_KEYNAME', 1061)) throw error;
      }
    }
  }
}

/**
 * initDb — call once at startup.
 * Creates the connection pool, tests connectivity, and ensures
 * the required tables exist (CREATE TABLE IF NOT EXISTS).
 */
async function initDb() {
  try {
    pool = mysql.createPool(buildPoolOptions());

    // Test that we can actually connect
    const conn = await pool.getConnection();
    conn.release();

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS date_ideas (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        vibe       VARCHAR(50)  NOT NULL,
        budget     VARCHAR(10)  NOT NULL,
        location   VARCHAR(50)  NOT NULL,
        notes      TEXT,
        display_order INT NOT NULL DEFAULT 0,
        status     ENUM('pending', 'done', 'favorite') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX ideas_order (display_order, id)
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS site_settings (
        setting_key   VARCHAR(50) PRIMARY KEY,
        setting_value VARCHAR(255) NOT NULL,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS timeline_milestones (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        display_order   INT NOT NULL DEFAULT 0,
        milestone_date  VARCHAR(100) NOT NULL,
        title           VARCHAR(150) NOT NULL,
        description     TEXT NOT NULL,
        emoji           VARCHAR(32) NOT NULL,
        photo           VARCHAR(255),
        link_url        VARCHAR(1000),
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX timeline_display_order (display_order, id)
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS bucket_items (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        title           VARCHAR(150) NOT NULL,
        description     TEXT NOT NULL,
        category        ENUM('travel', 'experience', 'food', 'home', 'growth', 'other')
                        NOT NULL DEFAULT 'other',
        target_date     DATE,
        display_order   INT NOT NULL DEFAULT 0,
        is_favorite     BOOLEAN NOT NULL DEFAULT FALSE,
        completed_at    DATE,
        memory          TEXT,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX bucket_status_target (completed_at, target_date),
        INDEX bucket_order (display_order, id)
      ) ENGINE=InnoDB
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS bucket_votes (
        item_id         INT NOT NULL,
        voter_slot      ENUM('partner_one', 'partner_two') NOT NULL,
        vote            ENUM('yes', 'maybe', 'not_yet') NOT NULL,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (item_id, voter_slot),
        CONSTRAINT bucket_votes_item_fk FOREIGN KEY (item_id)
          REFERENCES bucket_items(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS shared_events (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        title               VARCHAR(150) NOT NULL,
        event_at            DATETIME NOT NULL,
        reminder_at         DATETIME,
        notes               TEXT,
        display_order       INT NOT NULL DEFAULT 0,
        is_completed        BOOLEAN NOT NULL DEFAULT FALSE,
        reminder_dismissed  BOOLEAN NOT NULL DEFAULT FALSE,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX events_time (event_at),
        INDEX events_order (display_order, id),
        INDEX reminders_due (reminder_at, reminder_dismissed)
      ) ENGINE=InnoDB
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS photo_albums (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        title           VARCHAR(150) NOT NULL,
        description     TEXT NOT NULL,
        album_date      DATE,
        display_order   INT NOT NULL DEFAULT 0,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX albums_order (display_order, album_date, id)
      ) ENGINE=InnoDB
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS album_photos (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        album_id        INT NOT NULL,
        milestone_id    INT,
        caption         VARCHAR(1000),
        photo_date      DATE,
        display_order   INT NOT NULL DEFAULT 0,
        storage_type    ENUM('upload', 'existing') NOT NULL,
        storage_name    VARCHAR(255) NOT NULL,
        media_type      ENUM('image/jpeg', 'image/png', 'image/webp') NOT NULL,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX photos_album_order (album_id, display_order, id),
        CONSTRAINT album_photos_album_fk FOREIGN KEY (album_id)
          REFERENCES photo_albums(id) ON DELETE CASCADE,
        CONSTRAINT album_photos_milestone_fk FOREIGN KEY (milestone_id)
          REFERENCES timeline_milestones(id) ON DELETE SET NULL
      ) ENGINE=InnoDB
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        milestone_id    INT,
        title           VARCHAR(150) NOT NULL,
        body            TEXT NOT NULL,
        entry_date      DATE NOT NULL,
        display_order   INT NOT NULL DEFAULT 0,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX journal_date (entry_date, id),
        INDEX journal_order (display_order, id),
        INDEX journal_milestone (milestone_id),
        CONSTRAINT journal_milestone_fk FOREIGN KEY (milestone_id)
          REFERENCES timeline_milestones(id) ON DELETE SET NULL
      ) ENGINE=InnoDB
    `);
    await ensureContentOrderingSchema(pool);

    await pool.execute(`
      INSERT IGNORE INTO site_settings (setting_key, setting_value)
      VALUES
        ('partner_one_name', 'Gierael'),
        ('partner_two_name', 'Kim'),
        ('anniversary_date', '2025-12-08'),
        ('timezone', 'UTC')
    `);
    dbAvailable = true;
    try {
      await importTimelineOnce();
      await seedRelationshipBasics();
    } catch (error) {
      console.error('Timeline import failed; file fallback remains available:', error.message);
    }

    console.log('✅  Database connected and tables ready!');
  } catch (err) {
    console.warn('⚠️   Database not available:', err.message);
    console.warn('    The site will run without database features.');
    console.warn('    Check your .env DB_* variables and try again.');
    dbAvailable = false;
  }

}

async function seedRelationshipBasics(databasePool = pool) {
  const connection = await databasePool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT IGNORE INTO site_settings (setting_key, setting_value)
       VALUES (?, 'pending')`,
      [RELATIONSHIP_BASICS_MARKER],
    );
    const [markerRows] = await connection.execute(
      `SELECT setting_value FROM site_settings
       WHERE setting_key = ? FOR UPDATE`,
      [RELATIONSHIP_BASICS_MARKER],
    );
    if (markerRows[0]?.setting_value === 'complete') {
      await connection.commit();
      return false;
    }
    await connection.execute(`
      UPDATE site_settings
      SET setting_value = CASE setting_key
        WHEN 'partner_one_name' THEN 'Gierael'
        WHEN 'partner_two_name' THEN 'Kim'
        WHEN 'anniversary_date' THEN '2025-12-08'
        ELSE setting_value
      END
      WHERE (setting_key = 'partner_one_name' AND setting_value = 'Partner One')
         OR (setting_key = 'partner_two_name' AND setting_value = 'Partner Two')
         OR (setting_key = 'anniversary_date' AND setting_value = '')
    `);
    await connection.execute(
      `UPDATE timeline_milestones
       SET milestone_date = ?, title = ?, description = ?, emoji = ?
       WHERE milestone_date = 'Coming Soon'
         AND title = 'The Day We Met'
         AND description = 'Every love story has a first chapter. Ours started right here. ✨'
         AND emoji = '✨'`,
      [
        'December 8, 2025',
        'Officially Us',
        'The day we officially became boyfriend and girlfriend — the start of our great life together. 💕',
        '💕',
      ],
    );
    await connection.execute(
      `UPDATE site_settings SET setting_value = 'complete'
       WHERE setting_key = ?`,
      [RELATIONSHIP_BASICS_MARKER],
    );
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function importTimelineOnce(
  databasePool = pool,
  milestones = require('./data/timeline'),
) {
  const connection = await databasePool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT IGNORE INTO site_settings (setting_key, setting_value)
       VALUES (?, 'pending')`,
      [TIMELINE_IMPORT_MARKER],
    );
    const [markerRows] = await connection.execute(
      `SELECT setting_value FROM site_settings
       WHERE setting_key = ? FOR UPDATE`,
      [TIMELINE_IMPORT_MARKER],
    );
    if (markerRows[0]?.setting_value === 'complete') {
      await connection.commit();
      return false;
    }

    const [countRows] = await connection.execute(
      'SELECT COUNT(*) AS count FROM timeline_milestones',
    );
    const shouldImport = Number(countRows[0].count) === 0;
    if (shouldImport) {
      for (const [index, milestone] of milestones.entries()) {
        await connection.execute(
          `INSERT INTO timeline_milestones
            (display_order, milestone_date, title, description, emoji, photo, link_url)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          [
            index,
            milestone.date,
            milestone.title,
            milestone.description,
            milestone.emoji,
            milestone.photo || null,
          ],
        );
      }
    }
    await connection.execute(
      `UPDATE site_settings SET setting_value = 'complete'
       WHERE setting_key = ?`,
      [TIMELINE_IMPORT_MARKER],
    );
    await connection.commit();
    if (shouldImport) {
      console.log(`Imported ${milestones.length} timeline milestones from data/timeline.js.`);
    }
    return shouldImport;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** Returns the mysql2 pool (or null if DB is unavailable). */
function getPool() {
  return pool;
}

/** Returns true when the DB is connected and ready to query. */
function isDbAvailable() {
  return dbAvailable;
}

module.exports = {
  RELATIONSHIP_BASICS_MARKER,
  TIMELINE_IMPORT_MARKER,
  buildPoolOptions,
  ensureContentOrderingSchema,
  getPool,
  importTimelineOnce,
  initDb,
  isDbAvailable,
  seedRelationshipBasics,
};
