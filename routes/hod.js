const express = require('express');
const router = express.Router();
const { db } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { approve, reject } = require('../services/approvalService');

router.use(requireRole('hod'));

function activeSession() {
  return db.prepare('SELECT * FROM academic_sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
}
function myDept(req) {
  return db.prepare(`
<<<<<<< HEAD
    SELECT d.*, c.name AS college_name FROM departments d
    LEFT JOIN colleges c ON c.id = d.college_id
=======
    SELECT d.*, f.name AS faculty_name FROM departments d
    LEFT JOIN faculties f ON f.id = d.faculty_id
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
    WHERE d.id = ?
  `).get(req.session.user.department_id);
}
// True if a given timetable entry belongs to this HOD's own department —
// checked before approve/reject so an HOD can't act outside their own
// department even if they guess another entry's id (mirrors the same
<<<<<<< HEAD
// check on the Dean side for college).
=======
// check on the Dean side for faculty).
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
function entryInDept(entryId, departmentId) {
  const row = db.prepare(`
    SELECT c.department_id FROM timetable_entries te
    JOIN course_offerings co ON co.id = te.offering_id
    JOIN courses c ON c.id = co.course_id
    WHERE te.id = ?
  `).get(entryId);
  return row && row.department_id === departmentId;
}

router.get('/', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
<<<<<<< HEAD
  let pendingCount = 0, courseCount = 0, pendingCourseCount = 0, programmeCount = 0;
  if (dept) {
    courseCount = db.prepare('SELECT COUNT(*) c FROM courses WHERE department_id = ?').get(dept.id).c;
    pendingCourseCount = db.prepare("SELECT COUNT(*) c FROM courses WHERE department_id = ? AND status = 'pending'").get(dept.id).c;
    programmeCount = db.prepare('SELECT COUNT(*) c FROM programmes WHERE department_id = ?').get(dept.id).c;
=======
  let pendingCount = 0, courseCount = 0, pendingCourseCount = 0;
  if (dept) {
    courseCount = db.prepare('SELECT COUNT(*) c FROM courses WHERE department_id = ?').get(dept.id).c;
    pendingCourseCount = db.prepare("SELECT COUNT(*) c FROM courses WHERE department_id = ? AND status = 'pending'").get(dept.id).c;
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
  }
  if (dept && session) {
    pendingCount = db.prepare(`
      SELECT COUNT(*) c FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      WHERE c.department_id = ? AND co.session_id = ? AND te.status = 'lecturer_ok'
    `).get(dept.id, session.id).c;
  }
<<<<<<< HEAD
  res.render('hod/dashboard', { title: 'HOD dashboard', dept, session, pendingCount, courseCount, pendingCourseCount, programmeCount });
});

// ---------- Programmes (the HOD's own department only) ----------
router.get('/programmes', (req, res) => {
  const dept = myDept(req);
  let programmes = [];
  if (dept) {
    programmes = db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM courses c WHERE c.programme_id = p.id) AS course_count
      FROM programmes p WHERE p.department_id = ? ORDER BY p.name
    `).all(dept.id);
  }
  res.render('hod/programmes', { title: 'Programmes', dept, programmes });
});

router.post('/programmes', (req, res) => {
  const dept = myDept(req);
  if (!dept) return res.redirect('/hod/programmes');
  const { name, code } = req.body;
  db.prepare('INSERT INTO programmes (name, code, department_id) VALUES (?, ?, ?)').run(name, code, dept.id);
  res.redirect('/hod/programmes');
});

router.post('/programmes/:id/edit', (req, res) => {
  const dept = myDept(req);
  const programme = dept && db.prepare('SELECT * FROM programmes WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!programme) return res.redirect('/hod/programmes');
  const { name, code } = req.body;
  db.prepare('UPDATE programmes SET name = ?, code = ? WHERE id = ?').run(name, code, programme.id);
  res.redirect('/hod/programmes');
});

router.post('/programmes/:id/delete', (req, res) => {
  const dept = myDept(req);
  const programme = dept && db.prepare('SELECT * FROM programmes WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!programme) return res.redirect('/hod/programmes');
  const inUse = db.prepare('SELECT 1 FROM courses WHERE programme_id = ?').get(programme.id);
  if (!inUse) {
    db.prepare('DELETE FROM programmes WHERE id = ?').run(programme.id);
  }
  res.redirect('/hod/programmes');
=======
  res.render('hod/dashboard', { title: 'HOD dashboard', dept, session, pendingCount, courseCount, pendingCourseCount });
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
});

// ---------- Courses (create/edit/delete proposals; Dean approves) ----------
router.get('/courses', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
<<<<<<< HEAD
  let courses = [], programmes = [];
  if (dept) {
    courses = db.prepare(`
      SELECT c.*, p.name AS programme_name,
             (SELECT COUNT(*) FROM course_offerings co WHERE co.course_id = c.id AND co.session_id = ?) AS offered_this_session
      FROM courses c
      LEFT JOIN programmes p ON p.id = c.programme_id
      WHERE c.department_id = ?
      ORDER BY c.code
    `).all(session ? session.id : 0, dept.id);
    programmes = db.prepare('SELECT * FROM programmes WHERE department_id = ? ORDER BY name').all(dept.id);
  }
  res.render('hod/courses', { title: 'Courses', dept, session, courses, programmes });
=======
  let courses = [];
  if (dept) {
    courses = db.prepare(`
      SELECT c.*,
             (SELECT COUNT(*) FROM course_offerings co WHERE co.course_id = c.id AND co.session_id = ?) AS offered_this_session
      FROM courses c
      WHERE c.department_id = ?
      ORDER BY c.code
    `).all(session ? session.id : 0, dept.id);
  }
  res.render('hod/courses', { title: 'Courses', dept, session, courses });
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
});

router.post('/courses', (req, res) => {
  const dept = myDept(req);
  if (!dept) return res.redirect('/hod/courses');
<<<<<<< HEAD
  const { code, title, credit_units, programme_id, level, expected_class_size } = req.body;
  db.prepare(`
    INSERT INTO courses (code, title, credit_units, department_id, programme_id, level, expected_class_size, status, created_by)
    VALUES (?,?,?,?,?,?,?,'pending',?)
  `).run(code, title, credit_units || 3, dept.id, programme_id || null, level, expected_class_size || null, req.session.user.id);
=======
  const { code, title, credit_units, level } = req.body;
  db.prepare(`
    INSERT INTO courses (code, title, credit_units, department_id, level, status, created_by)
    VALUES (?,?,?,?,?,'pending',?)
  `).run(code, title, credit_units || 3, dept.id, level, req.session.user.id);
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
  res.redirect('/hod/courses');
});

router.post('/courses/:id/edit', (req, res) => {
  const dept = myDept(req);
  const course = dept && db.prepare('SELECT * FROM courses WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  // Only editable while it hasn't been signed off yet — once approved, it's
  // locked here (the registrar can still adjust it directly if needed).
  if (!course || !['pending', 'rejected'].includes(course.status)) return res.redirect('/hod/courses');
<<<<<<< HEAD
  const { code, title, credit_units, programme_id, level, expected_class_size } = req.body;
  // Editing a rejected proposal resubmits it — back to pending, reason cleared.
  db.prepare(`
    UPDATE courses SET code = ?, title = ?, credit_units = ?, programme_id = ?, level = ?, expected_class_size = ?,
           status = 'pending', reject_reason = NULL
    WHERE id = ?
  `).run(code, title, credit_units || 3, programme_id || null, level, expected_class_size || null, course.id);
=======
  const { code, title, credit_units, level } = req.body;
  // Editing a rejected proposal resubmits it — back to pending, reason cleared.
  db.prepare(`
    UPDATE courses SET code = ?, title = ?, credit_units = ?, level = ?, status = 'pending', reject_reason = NULL
    WHERE id = ?
  `).run(code, title, credit_units || 3, level, course.id);
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
  res.redirect('/hod/courses');
});

router.post('/courses/:id/delete', (req, res) => {
  const dept = myDept(req);
  const course = dept && db.prepare('SELECT * FROM courses WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!course || !['pending', 'rejected'].includes(course.status)) return res.redirect('/hod/courses');
  const hasOfferings = db.prepare('SELECT 1 FROM course_offerings WHERE course_id = ?').get(course.id);
  if (!hasOfferings) {
    db.prepare('DELETE FROM courses WHERE id = ?').run(course.id);
  }
  res.redirect('/hod/courses');
});

router.post('/courses/:id/offer', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
  const course = dept && db.prepare('SELECT * FROM courses WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!course || course.status !== 'approved' || !session) return res.redirect('/hod/courses');
  try {
    db.prepare('INSERT INTO course_offerings (course_id, session_id) VALUES (?, ?)').run(course.id, session.id);
  } catch (e) { /* already offered this session */ }
  res.redirect('/hod/courses');
});

// ---------- Assign lecturers to courses ----------
router.get('/assign', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
  let offerings = [];
  if (dept && session) {
    offerings = db.prepare(`
      SELECT co.*, c.code, c.title FROM course_offerings co
      JOIN courses c ON c.id = co.course_id
      WHERE c.department_id = ? AND co.session_id = ?
    `).all(dept.id, session.id);
  }
  const lecturers = dept ? db.prepare("SELECT * FROM users WHERE role='lecturer' AND department_id = ?").all(dept.id) : [];
  res.render('hod/assign', { title: 'Assign lecturers', dept, session, offerings, lecturers });
});

router.post('/assign/:offeringId', (req, res) => {
  const { lecturer_id } = req.body;
  db.prepare('UPDATE course_offerings SET lecturer_id = ? WHERE id = ?').run(lecturer_id, req.params.offeringId);
  res.redirect('/hod/assign');
});

// ---------- Approval queue ----------
router.get('/approvals', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
  let entries = [];
  if (dept && session) {
    entries = db.prepare(`
      SELECT te.*, c.code, c.title, u.name AS lecturer_name, v.name AS venue_name, ts.day, ts.start_time, ts.end_time
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      LEFT JOIN venues v ON v.id = te.venue_id
      LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
      WHERE c.department_id = ? AND co.session_id = ? AND te.status = 'lecturer_ok'
    `).all(dept.id, session.id);
  }
  res.render('hod/approvals', { title: 'Approval queue', dept, session, entries });
});

router.post('/approvals/:id/approve', (req, res) => {
  const dept = myDept(req);
  try {
    if (dept && entryInDept(req.params.id, dept.id)) {
      approve(req.params.id, 'hod', req.session.user.id);
    }
  } catch (e) { /* ignore */ }
  res.redirect('/hod/approvals');
});

router.post('/approvals/:id/reject', (req, res) => {
  const dept = myDept(req);
  try {
    if (dept && entryInDept(req.params.id, dept.id)) {
      reject(req.params.id, 'hod', req.session.user.id, req.body.reason || 'Rejected by HOD');
    }
  } catch (e) { /* ignore */ }
  res.redirect('/hod/approvals');
});

// ---------- Department timetable (all statuses, for visibility) ----------
router.get('/timetable', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
  const bands = db.prepare('SELECT DISTINCT start_time, end_time FROM timeslots ORDER BY start_time').all();
  let entries = [];
  if (dept && session) {
    entries = db.prepare(`
      SELECT te.*, c.code, c.title, u.name AS lecturer_name, v.name AS venue_name, v.capacity,
             ts.day, ts.start_time, ts.end_time, co.registered_count
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      LEFT JOIN venues v ON v.id = te.venue_id
      LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
      WHERE c.department_id = ? AND co.session_id = ? AND te.status != 'rejected'
    `).all(dept.id, session.id);
  }
  res.render('hod/timetable', { title: 'Department timetable', dept, session, entries, bands });
});

module.exports = router;
