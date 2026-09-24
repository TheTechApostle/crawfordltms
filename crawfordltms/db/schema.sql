-- Crawford University Lecture Timetable Management System
-- Schema mirrors the ER diagram in the design document.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','dean','hod','lecturer','student')),
  department_id INTEGER REFERENCES departments(id),
  college_id    INTEGER REFERENCES colleges(id), -- a Dean's own college
  level         INTEGER,                 -- for students, e.g. 100/200/300/400
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS colleges (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  code     TEXT NOT NULL UNIQUE,
  dean_id  INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  code        TEXT NOT NULL UNIQUE,
  college_id  INTEGER REFERENCES colleges(id),
  hod_id      INTEGER REFERENCES users(id)
);

-- A department can run several programmes (e.g. Dept. of Computer and
-- Mathematical Sciences -> Computer Science / ICT / Cyber Security).
-- Courses are uploaded against a programme, not the bare department.
CREATE TABLE IF NOT EXISTS programmes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  code          TEXT NOT NULL,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  UNIQUE(department_id, code)
);

CREATE TABLE IF NOT EXISTS academic_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,      -- e.g. "2025/2026 - First Semester"
  is_active   INTEGER NOT NULL DEFAULT 0,
  reg_locked  INTEGER NOT NULL DEFAULT 0, -- registration lock (Fig.1 dependency)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  code                  TEXT NOT NULL UNIQUE,     -- e.g. CSC313
  title                 TEXT NOT NULL,
  credit_units          INTEGER NOT NULL DEFAULT 3,
  department_id         INTEGER NOT NULL REFERENCES departments(id),
  programme_id          INTEGER REFERENCES programmes(id), -- which programme this course is uploaded under
  level                 INTEGER NOT NULL,
  expected_class_size   INTEGER,        -- HOD's estimate, used to provisionally allocate before registration closes
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected')),
  reject_reason         TEXT,
  created_by            INTEGER REFERENCES users(id) -- who proposed it (HOD) or added it directly (registrar)
);

CREATE TABLE IF NOT EXISTS venues (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  building  TEXT,
  capacity  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS timeslots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  day       TEXT NOT NULL,               -- Monday..Friday
  start_time TEXT NOT NULL,              -- '08:00'
  end_time   TEXT NOT NULL               -- '10:00'
);

CREATE TABLE IF NOT EXISTS course_offerings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id        INTEGER NOT NULL REFERENCES courses(id),
  lecturer_id      INTEGER REFERENCES users(id),
  session_id       INTEGER NOT NULL REFERENCES academic_sessions(id),
  registered_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(course_id, session_id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  offering_id INTEGER NOT NULL REFERENCES course_offerings(id),
  student_id  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(offering_id, student_id)
);

CREATE TABLE IF NOT EXISTS timetable_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  offering_id INTEGER NOT NULL REFERENCES course_offerings(id),
  venue_id    INTEGER REFERENCES venues(id),
  timeslot_id INTEGER REFERENCES timeslots(id),
  fit_ratio   REAL,
  is_provisional INTEGER NOT NULL DEFAULT 0, -- allocated from expected_class_size, not real registrations yet
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','lecturer_ok','hod_ok','final','published','shortfall','rejected')),
  reject_reason TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approval_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id       INTEGER NOT NULL REFERENCES timetable_entries(id),
  approver_role  TEXT NOT NULL,
  approver_id    INTEGER REFERENCES users(id),
  decision       TEXT NOT NULL,          -- accepted / rejected / published
  reason         TEXT,
  timestamp      TEXT NOT NULL DEFAULT (datetime('now'))
);
