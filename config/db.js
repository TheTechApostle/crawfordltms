const path = require('path');
const fs = require('fs');
// Node's built-in SQLite driver (stable enough for this app, and needs no
// native compilation step — better-sqlite3 requires a C++ toolchain to
// install, which isn't guaranteed on every machine this runs on).
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'crawford_ltms.sqlite');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

const isNew = !fs.existsSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Always (re)apply schema — CREATE TABLE IF NOT EXISTS is safe on existing DBs.
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Lightweight migration: CREATE TABLE IF NOT EXISTS won't retroactively add a
// new column to a table that already existed (e.g. a db seeded before the
// Faculty layer was introduced). Patch that in for anyone re-running against
// an older database file instead of a fresh one.
const departmentCols = db.prepare("PRAGMA table_info(departments)").all();
if (!departmentCols.some(c => c.name === 'faculty_id')) {
  db.exec('ALTER TABLE departments ADD COLUMN faculty_id INTEGER REFERENCES faculties(id)');
}
const userCols = db.prepare("PRAGMA table_info(users)").all();
if (!userCols.some(c => c.name === 'faculty_id')) {
  db.exec('ALTER TABLE users ADD COLUMN faculty_id INTEGER REFERENCES faculties(id)');
}
const courseCols = db.prepare("PRAGMA table_info(courses)").all();
if (!courseCols.some(c => c.name === 'status')) {
  db.exec("ALTER TABLE courses ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  db.exec('ALTER TABLE courses ADD COLUMN reject_reason TEXT');
  db.exec('ALTER TABLE courses ADD COLUMN created_by INTEGER REFERENCES users(id)');
  // Anything already offered in some session was clearly already in active
  // use before this approval workflow existed — grandfather those in as
  // approved rather than retroactively blocking them.
  db.exec(`
    UPDATE courses SET status = 'approved'
    WHERE id IN (SELECT DISTINCT course_id FROM course_offerings)
  `);
}

module.exports = { db, isNew };
