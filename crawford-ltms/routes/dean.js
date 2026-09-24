const express = require('express');
const router = express.Router();
const { db } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { approve, reject } = require('../services/approvalService');

router.use(requireRole('dean'));

function activeSession() {
  return db.prepare('SELECT * FROM academic_sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
}
function myFaculty(req) {
  if (!req.session.user.faculty_id) return null;
  return db.prepare('SELECT * FROM faculties WHERE id = ?').get(req.session.user.faculty_id);
}
// True if a given timetable entry belongs to a department under this dean's
// faculty — checked before approve/reject so a dean can't act outside their
// own faculty even if they guess another entry's id.
function entryInFaculty(entryId, facultyId) {
  const row = db.prepare(`
    SELECT d.faculty_id FROM timetable_entries te
    JOIN course_offerings co ON co.id = te.offering_id
    JOIN courses c ON c.id = co.course_id
    JOIN departments d ON d.id = c.department_id
    WHERE te.id = ?
  `).get(entryId);
  return row && row.faculty_id === facultyId;
}
// Same idea, for a pending course proposal rather than a timetable entry.
function courseInFaculty(courseId, facultyId) {
  const row = db.prepare(`
    SELECT d.faculty_id FROM courses c
    JOIN departments d ON d.id = c.department_id
    WHERE c.id = ?
  `).get(courseId);
  return row && row.faculty_id === facultyId;
}

router.get('/', (req, res) => {
  const faculty = myFaculty(req);
  const session = activeSession();
  let pendingCount = 0, clashCount = 0, pendingCourseCount = 0, departmentCount = 0;
  if (faculty && session) {
    pendingCount = db.prepare(`
      SELECT COUNT(*) c FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      JOIN departments d ON d.id = c.department_id
      WHERE co.session_id = ? AND d.faculty_id = ? AND te.status = 'hod_ok'
    `).get(session.id, faculty.id).c;
    clashCount = findClashes(session.id, faculty.id).length;
  }
  if (faculty) {
    pendingCourseCount = db.prepare(`
      SELECT COUNT(*) c FROM courses c
      JOIN departments d ON d.id = c.department_id
      WHERE d.faculty_id = ? AND c.status = 'pending'
    `).get(faculty.id).c;
    departmentCount = db.prepare('SELECT COUNT(*) c FROM departments WHERE faculty_id = ?').get(faculty.id).c;
  }
  res.render('dean/dashboard', { title: 'Dean dashboard', faculty, session, pendingCount, clashCount, pendingCourseCount, departmentCount });
});

// ---------- Course approvals ----------
router.get('/courses', (req, res) => {
  const faculty = myFaculty(req);
  let courses = [];
  if (faculty) {
    courses = db.prepare(`
      SELECT c.*, d.name AS dept_name, u.name AS proposed_by FROM courses c
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN users u ON u.id = c.created_by
      WHERE d.faculty_id = ?
      ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.code
    `).all(faculty.id);
  }
  res.render('dean/courses', { title: 'Course approvals', faculty, courses });
});

router.post('/courses/:id/approve', (req, res) => {
  const faculty = myFaculty(req);
  if (faculty && courseInFaculty(req.params.id, faculty.id)) {
    db.prepare("UPDATE courses SET status = 'approved', reject_reason = NULL WHERE id = ?").run(req.params.id);
  }
  res.redirect('/dean/courses');
});

// A Dean can fix a small mistake in a still-pending proposal directly
// rather than bouncing it back to the HOD with a rejection reason — only
// while it hasn't been decided on yet, and only within their own faculty.
router.post('/courses/:id/edit', (req, res) => {
  const faculty = myFaculty(req);
  const course = faculty && courseInFaculty(req.params.id, faculty.id)
    ? db.prepare("SELECT * FROM courses WHERE id = ? AND status = 'pending'").get(req.params.id)
    : null;
  if (course) {
    const { code, title, credit_units, level } = req.body;
    db.prepare('UPDATE courses SET code = ?, title = ?, credit_units = ?, level = ? WHERE id = ?')
      .run(code, title, credit_units || 3, level, course.id);
  }
  res.redirect('/dean/courses');
});

router.post('/courses/:id/reject', (req, res) => {
  const faculty = myFaculty(req);
  if (faculty && courseInFaculty(req.params.id, faculty.id)) {
    db.prepare("UPDATE courses SET status = 'rejected', reject_reason = ? WHERE id = ?")
      .run(req.body.reason || 'Not approved', req.params.id);
  }
  res.redirect('/dean/courses');
});

router.get('/approvals', (req, res) => {
  const faculty = myFaculty(req);
  const session = activeSession();
  let entries = [];
  if (faculty && session) {
    entries = db.prepare(`
      SELECT te.*, c.code, c.title, d.name AS dept_name, u.name AS lecturer_name,
             v.name AS venue_name, ts.day, ts.start_time, ts.end_time
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      LEFT JOIN venues v ON v.id = te.venue_id
      LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
      WHERE co.session_id = ? AND d.faculty_id = ? AND te.status = 'hod_ok'
    `).all(session.id, faculty.id);
  }
  res.render('dean/approvals', { title: 'Approval queue', faculty, session, entries });
});

router.post('/approvals/:id/approve', (req, res) => {
  const faculty = myFaculty(req);
  try {
    if (faculty && entryInFaculty(req.params.id, faculty.id)) {
      approve(req.params.id, 'dean', req.session.user.id);
    }
  } catch (e) { /* ignore */ }
  res.redirect('/dean/approvals');
});

router.post('/approvals/:id/reject', (req, res) => {
  const faculty = myFaculty(req);
  try {
    if (faculty && entryInFaculty(req.params.id, faculty.id)) {
      reject(req.params.id, 'dean', req.session.user.id, req.body.reason || 'Cross-department clash');
    }
  } catch (e) { /* ignore */ }
  res.redirect('/dean/approvals');
});

function findClashes(sessionId, facultyId) {
  const rows = db.prepare(`
    SELECT te.venue_id, te.timeslot_id, GROUP_CONCAT(c.code) AS courses, COUNT(*) c
    FROM timetable_entries te
    JOIN course_offerings co ON co.id = te.offering_id
    JOIN courses c ON c.id = co.course_id
    JOIN departments d ON d.id = c.department_id
    WHERE co.session_id = ? AND d.faculty_id = ? AND te.status != 'rejected' AND te.venue_id IS NOT NULL
    GROUP BY te.venue_id, te.timeslot_id
    HAVING COUNT(*) > 1
  `).all(sessionId, facultyId);
  return rows;
}

router.get('/clashes', (req, res) => {
  const faculty = myFaculty(req);
  const session = activeSession();
  const clashes = (faculty && session) ? findClashes(session.id, faculty.id) : [];
  res.render('dean/clashes', { title: 'Cross-department clashes', faculty, session, clashes });
});

// ---------- Departments overview (all departments under this dean's faculty) ----------
router.get('/departments', (req, res) => {
  const faculty = myFaculty(req);
  const session = activeSession();
  let departments = [], lecturersInCharge = [];

  if (faculty) {
    departments = db.prepare(`
      SELECT d.*, u.name AS hod_name, u.email AS hod_email,
             (SELECT COUNT(*) FROM courses c WHERE c.department_id = d.id AND c.status = 'approved') AS approved_courses,
             (SELECT COUNT(*) FROM courses c WHERE c.department_id = d.id AND c.status = 'pending') AS pending_courses,
             (SELECT COUNT(*) FROM users lu WHERE lu.department_id = d.id AND lu.role = 'lecturer') AS lecturer_count,
             (SELECT COUNT(*) FROM users su WHERE su.department_id = d.id AND su.role = 'student') AS student_count,
             (SELECT COUNT(*) FROM course_offerings co
              JOIN courses c ON c.id = co.course_id
              WHERE c.department_id = d.id AND co.session_id = ?) AS offerings_this_session
      FROM departments d
      LEFT JOIN users u ON u.id = d.hod_id
      WHERE d.faculty_id = ?
      ORDER BY d.name
    `).all(session ? session.id : 0, faculty.id);

    if (session) {
      lecturersInCharge = db.prepare(`
        SELECT c.code, c.title, d.name AS dept_name, u.name AS lecturer_name, u.email AS lecturer_email,
               co.registered_count,
               (SELECT te.status FROM timetable_entries te
                WHERE te.offering_id = co.id AND te.status != 'rejected'
                ORDER BY te.id DESC LIMIT 1) AS entry_status
        FROM course_offerings co
        JOIN courses c ON c.id = co.course_id
        JOIN departments d ON d.id = c.department_id
        LEFT JOIN users u ON u.id = co.lecturer_id
        WHERE d.faculty_id = ? AND co.session_id = ?
        ORDER BY d.name, c.code
      `).all(faculty.id, session.id);
    }
  }

  res.render('dean/departments', { title: 'Departments', faculty, session, departments, lecturersInCharge });
});

// ---------- Faculty-wide timetable grid ----------
router.get('/timetable', (req, res) => {
  const faculty = myFaculty(req);
  const session = activeSession();
  const bands = db.prepare('SELECT DISTINCT start_time, end_time FROM timeslots ORDER BY start_time').all();
  let entries = [];
  if (faculty && session) {
    entries = db.prepare(`
      SELECT te.*, c.code, c.title, d.name AS dept_name,
             u.name AS lecturer_name, v.name AS venue_name, v.capacity,
             ts.day, ts.start_time, ts.end_time, co.registered_count
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      LEFT JOIN venues v ON v.id = te.venue_id
      LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
      WHERE co.session_id = ? AND d.faculty_id = ? AND te.status != 'rejected' AND te.timeslot_id IS NOT NULL
      ORDER BY c.code
    `).all(session.id, faculty.id);
  }
  res.render('dean/timetable', { title: 'Faculty timetable', faculty, session, entries, bands });
});

module.exports = router;
