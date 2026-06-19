/**
 * db.js — MySQL database connection
 *
 * This module creates a connection pool to your MySQL database.
 * The app will start fine even if the DB is unavailable — it
 * just disables the adventure-planner save/load features until
 * the connection is restored.
 */

const mysql = require('mysql2/promise');

// Track whether the DB is up so routes can degrade gracefully
let pool = null;
let dbAvailable = false;

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

    // Create the date_ideas table if it doesn't exist yet
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

    dbAvailable = true;
    console.log('✅  Database connected and tables ready!');
  } catch (err) {
    console.warn('⚠️   Database not available:', err.message);
    console.warn('    The site will run without database features.');
    console.warn('    Check your .env DB_* variables and try again.');
    dbAvailable = false;
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

module.exports = { initDb, getPool, isDbAvailable };
