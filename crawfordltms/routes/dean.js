const express = require('express');
const router = express.Router();
const { db } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { approve, reject } = require('../services/approvalService');

router.use(requireRole('dean'));

function activeSession() {
  return db.prepare('SELECT * FROM academic_sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
}
function myCollege(req) {
  if (!req.session.user.college_id) return null;
  return db.prepare('SELECT * FROM colleges WHERE id = ?').get(req.session.user.college_id);
}
// True if a given timetable entry belongs to a department under this dean's
// college — checked before approve/reject so a dean can't act outside their
// own college even if they guess another entry's id.
function entryInCollege(entryId, collegeId) {
  const row = db.prepare(`
    SELECT d.college_id FROM timetable_entries te
    JOIN course_offerings co ON co.id = te.offering_id
    JOIN courses c ON c.id = co.course_id
    JOIN departments d ON d.id = c.department_id
    WHERE te.id = ?
  `).get(entryId);
  return row && row.college_id === collegeId;
}
// Same idea, for a pending course proposal rather than a timetable entry.
function courseInCollege(courseId, collegeId) {
  const row = db.prepare(`
    SELECT d.college_id FROM courses c
    JOIN departments d ON d.id = c.department_id
    WHERE c.id = ?
  `).get(courseId);
  return row && row.college_id === collegeId;
}
// True if a given department belongs to this dean's college.
function deptInCollege(departmentId, collegeId) {
  const row = db.prepare('SELECT college_id FROM departments WHERE id = ?').get(departmentId);
  return row && row.college_id === collegeId;
}
// True if a given programme's department belongs to this dean's college.
function programmeInCollege(programmeId, collegeId) {
  const row = db.prepare(`
    SELECT d.college_id FROM programmes p JOIN departments d ON d.id = p.department_id WHERE p.id = ?
  `).get(programmeId);
  return row && row.college_id === collegeId;
}

router.get('/', (req, res) => {
  const college = myCollege(req);
  const session = activeSession();
  let pendingCount = 0, clashCount = 0, pendingCourseCount = 0, departmentCount = 0;
  if (college && session) {
    pendingCount = db.prepare(`
      SELECT COUNT(*) c FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      JOIN departments d ON d.id = c.department_id
      WHERE co.session_id = ? AND d.college_id = ? AND te.status = 'hod_ok'
    `).get(session.id, college.id).c;
    clashCount = findClashes(session.id, college.id).length;
  }
  if (college) {
    pendingCourseCount = db.prepare(`
      SELECT COUNT(*) c FROM courses c
      JOIN departments d ON d.id = c.department_id
      WHERE d.college_id = ? AND c.status = 'pending'
    `).get(college.id).c;
    departmentCount = db.prepare('SELECT COUNT(*) c FROM departments WHERE college_id = ?').get(college.id).c;
  }
  res.render('dean/dashboard', { title: 'Dean dashboard', college, session, pendingCount, clashCount, pendingCourseCount, departmentCount });
});

// ---------- Course approvals ----------
// Grouped by department -> programme so a Dean can approve everything under
// a department or a single programme in one action, instead of clicking
// through every individual course.
router.get('/courses', (req, res) => {
  const college = myCollege(req);
  let courses = [], departments = [], programmes = [];
  if (college) {
    courses = db.prepare(`
      SELECT c.*, d.name AS dept_name, d.id AS department_id, p.name AS programme_name, u.name AS proposed_by
      FROM courses c
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN programmes p ON p.id = c.programme_id
      LEFT JOIN users u ON u.id = c.created_by
      WHERE d.college_id = ?
      ORDER BY d.name, p.name, c.code
    `).all(college.id);
    departments = db.prepare('SELECT * FROM departments WHERE college_id = ? ORDER BY name').all(college.id);
    programmes = db.prepare(`
      SELECT p.* FROM programmes p JOIN departments d ON d.id = p.department_id
      WHERE d.college_id = ? ORDER BY p.name
    `).all(college.id);
  }
  res.render('dean/courses', { title: 'Course approvals', college, courses, departments, programmes });
});

router.post('/courses/:id/approve', (req, res) => {
  const college = myCollege(req);
  if (college && courseInCollege(req.params.id, college.id)) {
    db.prepare("UPDATE courses SET status = 'approved', reject_reason = NULL WHERE id = ?").run(req.params.id);
  }
  res.redirect('/dean/courses');
});

// Approve every still-pending course in one department at once — the
// Dean's day-to-day reality is deciding on a whole department's slate, not
// clicking through courses one at a time.
router.post('/courses/bulk-approve/department/:deptId', (req, res) => {
  const college = myCollege(req);
  if (college && deptInCollege(req.params.deptId, college.id)) {
    db.prepare(`
      UPDATE courses SET status = 'approved', reject_reason = NULL
      WHERE department_id = ? AND status = 'pending'
    `).run(req.params.deptId);
  }
  res.redirect('/dean/courses');
});

// Approve every still-pending course in one programme at once.
router.post('/courses/bulk-approve/programme/:programmeId', (req, res) => {
  const college = myCollege(req);
  if (college && programmeInCollege(req.params.programmeId, college.id)) {
    db.prepare(`
      UPDATE courses SET status = 'approved', reject_reason = NULL
      WHERE programme_id = ? AND status = 'pending'
    `).run(req.params.programmeId);
  }
  res.redirect('/dean/courses');
});

// A Dean can fix a small mistake in a still-pending proposal directly
// rather than bouncing it back to the HOD with a rejection reason — only
// while it hasn't been decided on yet, and only within their own college.
router.post('/courses/:id/edit', (req, res) => {
  const college = myCollege(req);
  const course = college && courseInCollege(req.params.id, college.id)
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
  const college = myCollege(req);
  if (college && courseInCollege(req.params.id, college.id)) {
    db.prepare("UPDATE courses SET status = 'rejected', reject_reason = ? WHERE id = ?")
      .run(req.body.reason || 'Not approved', req.params.id);
  }
  res.redirect('/dean/courses');
});

router.get('/approvals', (req, res) => {
  const college = myCollege(req);
  const session = activeSession();
  let entries = [];
  if (college && session) {
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
      WHERE co.session_id = ? AND d.college_id = ? AND te.status = 'hod_ok'
    `).all(session.id, college.id);
  }
  res.render('dean/approvals', { title: 'Approval queue', college, session, entries });
});

router.post('/approvals/:id/approve', (req, res) => {
  const college = myCollege(req);
  try {
    if (college && entryInCollege(req.params.id, college.id)) {
      approve(req.params.id, 'dean', req.session.user.id);
    }
  } catch (e) { /* ignore */ }
  res.redirect('/dean/approvals');
});

router.post('/approvals/:id/reject', (req, res) => {
  const college = myCollege(req);
  try {
    if (college && entryInCollege(req.params.id, college.id)) {
      reject(req.params.id, 'dean', req.session.user.id, req.body.reason || 'Cross-department clash');
    }
  } catch (e) { /* ignore */ }
  res.redirect('/dean/approvals');
});

function findClashes(sessionId, collegeId) {
  const rows = db.prepare(`
    SELECT te.venue_id, te.timeslot_id, GROUP_CONCAT(c.code) AS courses, COUNT(*) c
    FROM timetable_entries te
    JOIN course_offerings co ON co.id = te.offering_id
    JOIN courses c ON c.id = co.course_id
    JOIN departments d ON d.id = c.department_id
    WHERE co.session_id = ? AND d.college_id = ? AND te.status != 'rejected' AND te.venue_id IS NOT NULL
    GROUP BY te.venue_id, te.timeslot_id
    HAVING COUNT(*) > 1
  `).all(sessionId, collegeId);
  return rows;
}

router.get('/clashes', (req, res) => {
  const college = myCollege(req);
  const session = activeSession();
  const clashes = (college && session) ? findClashes(session.id, college.id) : [];
  res.render('dean/clashes', { title: 'Cross-department clashes', college, session, clashes });
});

// ---------- Departments overview (all departments under this dean's college) ----------
router.get('/departments', (req, res) => {
  const college = myCollege(req);
  const session = activeSession();
  let departments = [], lecturersInCharge = [];

  if (college) {
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
      WHERE d.college_id = ?
      ORDER BY d.name
    `).all(session ? session.id : 0, college.id);

    if (session) {
      lecturersInCharge = db.prepare(`
        SELECT c.code, c.title, d.name AS dept_name, u.name AS lecturer_name, u.email AS lecturer_email,
               co.registered_count
        FROM course_offerings co
        JOIN courses c ON c.id = co.course_id
        JOIN departments d ON d.id = c.department_id
        LEFT JOIN users u ON u.id = co.lecturer_id
        WHERE d.college_id = ? AND co.session_id = ?
        ORDER BY d.name, c.code
      `).all(college.id, session.id);
    }
  }

  res.render('dean/departments', { title: 'Departments', college, session, departments, lecturersInCharge });
});

// ---------- College-wide timetable ----------
router.get('/timetable', (req, res) => {
  const college = myCollege(req);
  const session = activeSession();
  const bands = db.prepare('SELECT DISTINCT start_time, end_time FROM timeslots ORDER BY start_time').all();
  let entries = [];
  if (college && session) {
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
      WHERE co.session_id = ? AND d.college_id = ? AND te.status != 'rejected' AND te.timeslot_id IS NOT NULL
    `).all(session.id, college.id);
  }
  res.render('dean/timetable', { title: 'College timetable', college, session, entries, bands });
});

module.exports = router;
