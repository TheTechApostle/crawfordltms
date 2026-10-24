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

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// Migrate an older database that still has the pre-rename `faculties` table
// / `faculty_id` columns over to `colleges` / `college_id` before the schema
// below (which only knows about colleges) gets applied.
if (tableExists('faculties') && !tableExists('colleges')) {
  db.exec('ALTER TABLE faculties RENAME TO colleges');
}
if (tableExists('departments') && hasColumn('departments', 'faculty_id') && !hasColumn('departments', 'college_id')) {
  db.exec('ALTER TABLE departments RENAME COLUMN faculty_id TO college_id');
}
if (tableExists('users') && hasColumn('users', 'faculty_id') && !hasColumn('users', 'college_id')) {
  db.exec('ALTER TABLE users RENAME COLUMN faculty_id TO college_id');
}

// Always (re)apply schema — CREATE TABLE IF NOT EXISTS is safe on existing DBs.
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Lightweight migrations: CREATE TABLE IF NOT EXISTS won't retroactively add
// a new column to a table that already existed (e.g. a db seeded before the
// College layer, or the Programme layer, was introduced). Patch those in for
// anyone re-running against an older database file instead of a fresh one.
if (!hasColumn('departments', 'college_id')) {
  db.exec('ALTER TABLE departments ADD COLUMN college_id INTEGER REFERENCES colleges(id)');
}
if (!hasColumn('users', 'college_id')) {
  db.exec('ALTER TABLE users ADD COLUMN college_id INTEGER REFERENCES colleges(id)');
}
if (!hasColumn('courses', 'status')) {
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
if (!hasColumn('courses', 'programme_id')) {
  db.exec('ALTER TABLE courses ADD COLUMN programme_id INTEGER REFERENCES programmes(id)');
}
if (!hasColumn('courses', 'expected_class_size')) {
  db.exec('ALTER TABLE courses ADD COLUMN expected_class_size INTEGER');
}
if (!hasColumn('timetable_entries', 'is_provisional')) {
  db.exec('ALTER TABLE timetable_entries ADD COLUMN is_provisional INTEGER NOT NULL DEFAULT 0');
}
if (!hasColumn('course_offerings', 'lecturer_estimate')) {
  db.exec('ALTER TABLE course_offerings ADD COLUMN lecturer_estimate INTEGER');
}


// ---------- Programme Coordinator / shared-course / venue-college migrations ----------

// 1. The `users.role` CHECK constraint predates the Programme Coordinator
// role, and SQLite can't alter a CHECK in place — so an older database has to
// have its users table rebuilt (same columns, same ids, wider CHECK). Fresh
// databases already get the right constraint from schema.sql and skip this.
(function allowCoordinatorRole() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!row || row.sql.includes("'coordinator'")) return;
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name).join(', ');
  const widened = row.sql
    .replace(/^CREATE TABLE\s+("?)users\1/i, 'CREATE TABLE users__new')
    .replace("'hod','lecturer'", "'hod','coordinator','lecturer'");
  db.exec('PRAGMA foreign_keys = OFF'); // must be set outside a transaction
  db.exec('BEGIN');
  try {
    db.exec(widened);
    db.exec(`INSERT INTO users__new (${cols}) SELECT ${cols} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users__new RENAME TO users');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
})();

// 2. New columns on existing tables.
if (!hasColumn('programmes', 'coordinator_id')) {
  db.exec('ALTER TABLE programmes ADD COLUMN coordinator_id INTEGER REFERENCES users(id)');
}
if (!hasColumn('venues', 'college_id')) {
  db.exec('ALTER TABLE venues ADD COLUMN college_id INTEGER REFERENCES colleges(id)');
}
if (!hasColumn('course_offerings', 'allocation_status')) {
  db.exec('ALTER TABLE course_offerings ADD COLUMN proposed_lecturer_id INTEGER REFERENCES users(id)');
  db.exec("ALTER TABLE course_offerings ADD COLUMN allocation_status TEXT NOT NULL DEFAULT 'none'");
  db.exec('ALTER TABLE course_offerings ADD COLUMN allocation_by INTEGER REFERENCES users(id)');
  db.exec('ALTER TABLE course_offerings ADD COLUMN allocation_reason TEXT');
  db.exec('ALTER TABLE course_offerings ADD COLUMN allocation_updated_at TEXT');
  // Every lecturer already assigned before this workflow existed was
  // assigned by the HOD directly — treat those as approved allocations.
  db.exec("UPDATE course_offerings SET allocation_status = 'approved' WHERE lecturer_id IS NOT NULL");
}

if (!hasColumn('courses', 'scope')) {
  db.exec("ALTER TABLE courses ADD COLUMN scope TEXT NOT NULL DEFAULT 'programmes'");
}
if (!hasColumn('courses', 'course_type')) {
  // Existing courses become 'compulsory' until the department marks the electives.
  db.exec("ALTER TABLE courses ADD COLUMN course_type TEXT NOT NULL DEFAULT 'compulsory' CHECK (course_type IN ('compulsory','elective'))");
}
if (!hasColumn('course_programmes', 'source')) {
  db.exec("ALTER TABLE course_programmes ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
}

// 2b. Level / semester / study-mode support.
if (!hasColumn('programmes', 'study_mode')) {
  db.exec("ALTER TABLE programmes ADD COLUMN study_mode TEXT NOT NULL DEFAULT 'full_time' CHECK (study_mode IN ('full_time','part_time','conversion'))");
}
if (!hasColumn('users', 'programme_id')) {
  db.exec('ALTER TABLE users ADD COLUMN programme_id INTEGER REFERENCES programmes(id)');
}
if (!hasColumn('courses', 'semester')) {
  db.exec('ALTER TABLE courses ADD COLUMN semester INTEGER NOT NULL DEFAULT 1');
}
if (!hasColumn('course_programmes', 'semester')) {
  db.exec('ALTER TABLE course_programmes ADD COLUMN semester INTEGER');
}
if (!hasColumn('academic_sessions', 'regular_semester')) {
  db.exec('ALTER TABLE academic_sessions ADD COLUMN regular_semester INTEGER NOT NULL DEFAULT 1');
  db.exec('ALTER TABLE academic_sessions ADD COLUMN conversion_semester INTEGER NOT NULL DEFAULT 1');
}
// Default semester names (editable by the registrar).
if (!db.prepare('SELECT 1 FROM semesters LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO semesters (calendar, number, name) VALUES (?,?,?)');
  ins.run('regular', 1, 'Harmattan'); ins.run('regular', 2, 'Rain');
  ins.run('conversion', 1, 'First Semester'); ins.run('conversion', 2, 'Second Semester'); ins.run('conversion', 3, 'Third Semester');
}
// An offering is now per (course, session, study mode, semester): rebuild the
// table once to widen its UNIQUE constraint. Ids are preserved, so timetable
// entries and enrollments keep pointing at the right rows.
if (!hasColumn('course_offerings', 'study_mode')) {
  const schemaSql = require('fs').readFileSync(require('path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const ddl = schemaSql.match(/CREATE TABLE IF NOT EXISTS course_offerings \([\s\S]*?\n\);/)[0]
    .replace('CREATE TABLE IF NOT EXISTS course_offerings', 'CREATE TABLE course_offerings__new');
  const oldCols = db.prepare('PRAGMA table_info(course_offerings)').all().map(c => c.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(ddl);
    db.exec(`INSERT INTO course_offerings__new (${oldCols}) SELECT ${oldCols} FROM course_offerings`);
    db.exec('DROP TABLE course_offerings');
    db.exec('ALTER TABLE course_offerings__new RENAME TO course_offerings');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// 3. Courses offered by several programmes: every course already tagged to a
// programme is linked to it in the new many-to-many table (idempotent).
db.exec(`
  INSERT OR IGNORE INTO course_programmes (course_id, programme_id)
  SELECT id, programme_id FROM courses WHERE programme_id IS NOT NULL
`);

module.exports = { db, isNew };
