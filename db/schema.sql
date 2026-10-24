-- Crawford University Lecture Timetable Management System
-- Schema mirrors the ER diagram in the design document.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','dean','hod','coordinator','lecturer','student')),
  department_id INTEGER REFERENCES departments(id),
  college_id    INTEGER REFERENCES colleges(id), -- a Dean's own college
  level         INTEGER,                 -- for students, e.g. 100/200/300/400
  programme_id  INTEGER REFERENCES programmes(id), -- a student's programme (and so their study mode)
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
  coordinator_id INTEGER REFERENCES users(id), -- the Programme Coordinator; NULL = no coordinator, so the HOD handles courses/allocation
  -- How the programme is run. The same degree in two modes is two programmes
  -- (e.g. "Computer Science" full-time and "Computer Science (Part-time)").
  study_mode TEXT NOT NULL DEFAULT 'full_time' CHECK (study_mode IN ('full_time','part_time','conversion')),
  UNIQUE(department_id, code)
);

CREATE TABLE IF NOT EXISTS academic_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,      -- e.g. "2025/2026 - First Semester"
  is_active   INTEGER NOT NULL DEFAULT 0,
  reg_locked  INTEGER NOT NULL DEFAULT 0, -- registration lock (Fig.1 dependency)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Which semester each calendar is currently in. Full-time and part-time run
  -- the 'regular' calendar (1 = Harmattan, 2 = Rain); conversion (HND -> BSc)
  -- runs its own three-semester calendar. Registration, timetabling and the
  -- lecturer/student portals work on the current semester of each calendar.
  regular_semester    INTEGER NOT NULL DEFAULT 1,
  conversion_semester INTEGER NOT NULL DEFAULT 1
);

-- Semester names per calendar ('regular' = full-time & part-time, 'conversion').
CREATE TABLE IF NOT EXISTS semesters (
  calendar TEXT NOT NULL CHECK (calendar IN ('regular','conversion')),
  number   INTEGER NOT NULL,
  name     TEXT NOT NULL,
  PRIMARY KEY (calendar, number)
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
  created_by            INTEGER REFERENCES users(id), -- who proposed it (HOD) or added it directly (registrar)
  -- Who the course is offered to: 'programmes' = the programmes listed in
  -- course_programmes; 'departments' = every programme of the departments in
  -- course_departments (plus any listed programmes); 'all' = every programme
  -- in the university (e.g. GST courses).
  scope                 TEXT NOT NULL DEFAULT 'programmes' CHECK (scope IN ('programmes','departments','all')),
  course_type           TEXT NOT NULL DEFAULT 'compulsory' CHECK (course_type IN ('compulsory','elective')),
  -- courses.level / courses.semester are the HOME programme's level and
  -- semester. Other programmes offering the course may take it at a different
  -- level or semester: see course_programmes.level / .semester.
  semester              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS venues (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  building  TEXT,
  capacity  INTEGER NOT NULL,
  college_id INTEGER REFERENCES colleges(id) -- owning college; NULL = shared / university-wide venue
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
  lecturer_estimate INTEGER,  -- lecturer's own guess for THIS session, so they
                              -- aren't stuck waiting on the HOD's course-level
                              -- estimate (or on registration finishing) before
                              -- fixing their own lecture's time/venue
  -- Lecturer allocation workflow. lecturer_id is always the *approved*
  -- lecturer (everything downstream - timetable, lecturer portal - keeps
  -- reading it). A Programme Coordinator's choice sits in
  -- proposed_lecturer_id until the HOD approves it, at which point it is
  -- copied into lecturer_id. An HOD (or the registrar) allocating directly
  -- writes lecturer_id and is approved immediately.
  proposed_lecturer_id INTEGER REFERENCES users(id),
  allocation_status    TEXT NOT NULL DEFAULT 'none'
                       CHECK (allocation_status IN ('none','pending','approved','rejected')),
  allocation_by        INTEGER REFERENCES users(id),
  allocation_reason    TEXT,   -- HOD's reason when an allocation is rejected
  allocation_updated_at TEXT,
  -- A course is taught once per (study mode, semester) in a session, with its
  -- own lecturer, class list and timetable slot: e.g. CYB201 full-time in
  -- Harmattan and CYB201 conversion in semester 2 are two offerings.
  study_mode TEXT NOT NULL DEFAULT 'full_time' CHECK (study_mode IN ('full_time','part_time','conversion')),
  semester   INTEGER NOT NULL DEFAULT 1,
  UNIQUE(course_id, session_id, study_mode, semester)
);

-- A course can be offered by several programmes (and so several colleges):
-- e.g. a GST / MTH / STA service course taken by Computer Science, ICT,
-- Engineering... courses.department_id is the *owning* department (the one
-- that proposes it and allocates its lecturer); this table lists every
-- programme the course is offered under, owner's programme(s) included.
-- The colleges a course serves are derived: programme -> department -> college.
CREATE TABLE IF NOT EXISTS course_programmes (
  course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  programme_id INTEGER NOT NULL REFERENCES programmes(id),
  level        INTEGER,   -- optional: level at which THIS programme takes the course, if it differs from courses.level
  semester     INTEGER,   -- optional: semester in which THIS programme takes it, if it differs from courses.semester
  linked_by    INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  source       TEXT NOT NULL DEFAULT 'manual',  -- 'manual' = picked/home; 'scope' = derived from courses.scope (re-synced automatically)
  PRIMARY KEY (course_id, programme_id)
);

-- Departments a course is offered to as a whole (courses.scope = 'departments'):
-- every programme in those departments, including ones added later.
CREATE TABLE IF NOT EXISTS course_departments (
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  PRIMARY KEY (course_id, department_id)
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
