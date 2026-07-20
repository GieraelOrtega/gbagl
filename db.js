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

/**
 * initDb — call once at startup.
 * Creates the connection pool, tests connectivity, and ensures
 * the required tables exist (CREATE TABLE IF NOT EXISTS).
 */
async function initDb() {
  try {
    pool = mysql.createPool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '3306', 10),
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'gbagl',
      waitForConnections: true,
      connectionLimit: 10,
      // Reconnect automatically if the DB drops briefly
      enableKeepAlive: true,
      keepAliveInitialDelay: 30000,
    });

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
        status     ENUM('pending', 'done', 'favorite') DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      INSERT IGNORE INTO site_settings (setting_key, setting_value)
      VALUES
        ('partner_one_name', 'Partner One'),
        ('partner_two_name', 'Partner Two'),
        ('anniversary_date', ''),
        ('timezone', 'UTC')
    `);
    dbAvailable = true;
    try {
      await importTimelineOnce();
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
  TIMELINE_IMPORT_MARKER,
  getPool,
  importTimelineOnce,
  initDb,
  isDbAvailable,
};
