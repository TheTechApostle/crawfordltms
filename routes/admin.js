const express = require('express');
const router = express.Router();
const { db } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { runAllocationEngine } = require('../services/allocationEngine');
const { approve, reject } = require('../services/approvalService');

router.use(requireRole('admin'));

function activeSession() {
  return db.prepare('SELECT * FROM academic_sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
}

// ---------- Dashboard ----------
router.get('/', (req, res) => {
  const session = activeSession();
  const counts = {
    faculties: db.prepare('SELECT COUNT(*) c FROM faculties').get().c,
    departments: db.prepare('SELECT COUNT(*) c FROM departments').get().c,
    courses: db.prepare('SELECT COUNT(*) c FROM courses').get().c,
    venues: db.prepare('SELECT COUNT(*) c FROM venues').get().c,
    students: db.prepare("SELECT COUNT(*) c FROM users WHERE role='student'").get().c,
  };
  let statusCounts = {};
  let shortfalls = [];
  if (session) {
    const rows = db.prepare(`
      SELECT te.status, COUNT(*) c FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      WHERE co.session_id = ? GROUP BY te.status
    `).all(session.id);
    rows.forEach(r => statusCounts[r.status] = r.c);
    shortfalls = db.prepare(`
      SELECT te.*, c.code, c.title, co.registered_count
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      WHERE co.session_id = ? AND te.status = 'shortfall'
    `).all(session.id);
  }
  res.render('admin/dashboard', { title: 'Registrar dashboard', session, counts, statusCounts, shortfalls });
});

// ---------- Sessions ----------
router.get('/sessions', (req, res) => {
  const sessions = db.prepare('SELECT * FROM academic_sessions ORDER BY id DESC').all();
  res.render('admin/sessions', { title: 'Academic sessions', sessions });
});

router.post('/sessions', (req, res) => {
  const { name } = req.body;
  db.prepare('INSERT INTO academic_sessions (name) VALUES (?)').run(name);
  res.redirect('/admin/sessions');
});

router.post('/sessions/:id/edit', (req, res) => {
  const { name } = req.body;
  db.prepare('UPDATE academic_sessions SET name = ? WHERE id = ?').run(name, req.params.id);
  res.redirect('/admin/sessions');
});

router.post('/sessions/:id/delete', (req, res) => {
  const hasOfferings = db.prepare('SELECT 1 FROM course_offerings WHERE session_id = ?').get(req.params.id);
  if (!hasOfferings) {
    db.prepare('DELETE FROM academic_sessions WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/sessions');
});

router.post('/sessions/:id/activate', (req, res) => {
  db.prepare('UPDATE academic_sessions SET is_active = 0').run();
  db.prepare('UPDATE academic_sessions SET is_active = 1 WHERE id = ?').run(req.params.id);
  res.redirect('/admin/sessions');
});

router.post('/sessions/:id/lock', (req, res) => {
  const s = db.prepare('SELECT * FROM academic_sessions WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE academic_sessions SET reg_locked = ? WHERE id = ?').run(s.reg_locked ? 0 : 1, req.params.id);
  res.redirect('/admin/sessions');
});

// ---------- Faculties ----------
router.get('/faculties', (req, res) => {
  const faculties = db.prepare(`
    SELECT f.*, u.name AS dean_name,
           (SELECT COUNT(*) FROM departments d WHERE d.faculty_id = f.id) AS dept_count
    FROM faculties f
    LEFT JOIN users u ON u.id = f.dean_id
    ORDER BY f.name
  `).all();
  const deans = db.prepare("SELECT * FROM users WHERE role='dean'").all();
  res.render('admin/faculties', { title: 'Faculties', faculties, deans });
});

router.post('/faculties', (req, res) => {
  const { name, code, dean_id } = req.body;
  const result = db.prepare('INSERT INTO faculties (name, code, dean_id) VALUES (?, ?, ?)').run(name, code, dean_id || null);
  // Keep the Dean's own faculty_id in sync — that's what actually scopes
  // their approval queue, not the reverse pointer on the faculty row.
  if (dean_id) {
    db.prepare('UPDATE users SET faculty_id = ? WHERE id = ?').run(result.lastInsertRowid, dean_id);
  }
  res.redirect('/admin/faculties');
});

router.post('/faculties/:id/edit', (req, res) => {
  const { name, code, dean_id } = req.body;
  db.prepare('UPDATE faculties SET name = ?, code = ?, dean_id = ? WHERE id = ?')
    .run(name, code, dean_id || null, req.params.id);
  // Reassigning the dean is a real change of authority, not just a label —
  // keep the newly-picked dean's own faculty_id in sync so their approval
  // queue actually follows. (A dean removed from this faculty keeps their
  // old faculty_id until reassigned elsewhere — we never null someone's
  // access out from under an unrelated edit.)
  if (dean_id) {
    db.prepare('UPDATE users SET faculty_id = ? WHERE id = ?').run(req.params.id, dean_id);
  }
  res.redirect('/admin/faculties');
});

router.post('/faculties/:id/delete', (req, res) => {
  const hasDepartments = db.prepare('SELECT 1 FROM departments WHERE faculty_id = ?').get(req.params.id);
  if (!hasDepartments) {
    db.prepare('DELETE FROM faculties WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/faculties');
});

// ---------- Departments ----------
router.get('/departments', (req, res) => {
  const departments = db.prepare(`
    SELECT d.*, u.name AS hod_name, f.name AS faculty_name,
           (SELECT COUNT(*) FROM courses c WHERE c.department_id = d.id) AS course_count,
           (SELECT COUNT(*) FROM users du WHERE du.department_id = d.id) AS user_count
    FROM departments d
    LEFT JOIN users u ON u.id = d.hod_id
    LEFT JOIN faculties f ON f.id = d.faculty_id
    ORDER BY d.name
  `).all();
  const hods = db.prepare("SELECT * FROM users WHERE role='hod'").all();
  const faculties = db.prepare('SELECT * FROM faculties ORDER BY name').all();
  res.render('admin/departments', { title: 'Departments', departments, hods, faculties });
});

router.post('/departments', (req, res) => {
  const { name, code, faculty_id, hod_id } = req.body;
  db.prepare('INSERT INTO departments (name, code, faculty_id, hod_id) VALUES (?, ?, ?, ?)')
    .run(name, code, faculty_id || null, hod_id || null);
  res.redirect('/admin/departments');
});

router.post('/departments/:id/edit', (req, res) => {
  const { name, code, faculty_id, hod_id } = req.body;
  db.prepare('UPDATE departments SET name = ?, code = ?, faculty_id = ?, hod_id = ? WHERE id = ?')
    .run(name, code, faculty_id || null, hod_id || null, req.params.id);
  // Same reasoning as faculty/dean above: reassigning the HOD here is meant
  // to actually hand them the department's approval queue, so keep the
  // newly-picked HOD's own department_id in sync.
  if (hod_id) {
    db.prepare('UPDATE users SET department_id = ? WHERE id = ?').run(req.params.id, hod_id);
  }
  res.redirect('/admin/departments');
});

router.post('/departments/:id/delete', (req, res) => {
  const inUse = db.prepare(`
    SELECT 1 WHERE EXISTS (SELECT 1 FROM courses WHERE department_id = ?)
       OR EXISTS (SELECT 1 FROM users WHERE department_id = ?)
  `).get(req.params.id, req.params.id);
  if (!inUse) {
    db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/departments');
});

// ---------- Courses ----------
router.get('/courses', (req, res) => {
  const session = activeSession();
  const courses = db.prepare(`
    SELECT c.*, d.name AS dept_name,
           (SELECT COUNT(*) FROM course_offerings co WHERE co.course_id = c.id) AS offering_count
    FROM courses c JOIN departments d ON d.id = c.department_id ORDER BY c.code
  `).all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  let offerings = [];
  if (session) {
    offerings = db.prepare(`
      SELECT co.*, c.code, c.title, u.name AS lecturer_name FROM course_offerings co
      JOIN courses c ON c.id = co.course_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      WHERE co.session_id = ?
    `).all(session.id);
  }
  res.render('admin/courses', { title: 'Courses', courses, departments, session, offerings });
});

router.post('/courses', (req, res) => {
  const { code, title, credit_units, department_id, level } = req.body;
  // The registrar has full authority — a course they add goes straight to
  // 'approved', skipping the Dean review that an HOD-proposed course needs.
  db.prepare(`
    INSERT INTO courses (code, title, credit_units, department_id, level, status, created_by)
    VALUES (?,?,?,?,?,'approved',?)
  `).run(code, title, credit_units || 3, department_id, level, req.session.user.id);
  res.redirect('/admin/courses');
});

router.post('/courses/:id/edit', (req, res) => {
  const { code, title, credit_units, department_id, level } = req.body;
  db.prepare('UPDATE courses SET code = ?, title = ?, credit_units = ?, department_id = ?, level = ? WHERE id = ?')
    .run(code, title, credit_units || 3, department_id, level, req.params.id);
  res.redirect('/admin/courses');
});

router.post('/courses/:id/delete', (req, res) => {
  const hasOfferings = db.prepare('SELECT 1 FROM course_offerings WHERE course_id = ?').get(req.params.id);
  if (!hasOfferings) {
    db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/courses');
});

// The registrar can override a course's approval status directly — the
// same ultimate authority that lets them create a course pre-approved.
router.post('/courses/:id/approve', (req, res) => {
  db.prepare("UPDATE courses SET status = 'approved', reject_reason = NULL WHERE id = ?").run(req.params.id);
  res.redirect('/admin/courses');
});

router.post('/courses/:id/reject', (req, res) => {
  db.prepare("UPDATE courses SET status = 'rejected', reject_reason = ? WHERE id = ?")
    .run(req.body.reason || 'Not approved by the registrar', req.params.id);
  res.redirect('/admin/courses');
});

router.post('/courses/:id/offer', (req, res) => {
  const session = activeSession();
  if (!session) return res.redirect('/admin/courses');
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course || course.status !== 'approved') return res.redirect('/admin/courses');
  try {
    db.prepare('INSERT INTO course_offerings (course_id, session_id) VALUES (?, ?)').run(req.params.id, session.id);
  } catch (e) { /* already offered this session */ }
  res.redirect('/admin/courses');
});

// ---------- Venues ----------
router.get('/venues', (req, res) => {
  const venues = db.prepare(`
    SELECT v.*, (SELECT COUNT(*) FROM timetable_entries te WHERE te.venue_id = v.id) AS use_count
    FROM venues v ORDER BY capacity DESC
  `).all();
  res.render('admin/venues', { title: 'Venues', venues });
});

router.post('/venues', (req, res) => {
  const { name, building, capacity } = req.body;
  db.prepare('INSERT INTO venues (name, building, capacity) VALUES (?,?,?)').run(name, building, capacity);
  res.redirect('/admin/venues');
});

router.post('/venues/:id/edit', (req, res) => {
  const { name, building, capacity } = req.body;
  db.prepare('UPDATE venues SET name = ?, building = ?, capacity = ? WHERE id = ?')
    .run(name, building, capacity, req.params.id);
  res.redirect('/admin/venues');
});

router.post('/venues/:id/delete', (req, res) => {
  const inUse = db.prepare('SELECT 1 FROM timetable_entries WHERE venue_id = ?').get(req.params.id);
  if (!inUse) {
    db.prepare('DELETE FROM venues WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/venues');
});

// ---------- Timeslots ----------
router.get('/timeslots', (req, res) => {
  const timeslots = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM timetable_entries te WHERE te.timeslot_id = t.id) AS use_count
    FROM timeslots t ORDER BY day, start_time
  `).all();
  res.render('admin/timeslots', { title: 'Timeslots', timeslots });
});

router.post('/timeslots', (req, res) => {
  const { day, start_time, end_time } = req.body;
  db.prepare('INSERT INTO timeslots (day, start_time, end_time) VALUES (?,?,?)').run(day, start_time, end_time);
  res.redirect('/admin/timeslots');
});

router.post('/timeslots/:id/edit', (req, res) => {
  const { day, start_time, end_time } = req.body;
  db.prepare('UPDATE timeslots SET day = ?, start_time = ?, end_time = ? WHERE id = ?')
    .run(day, start_time, end_time, req.params.id);
  res.redirect('/admin/timeslots');
});

router.post('/timeslots/:id/delete', (req, res) => {
  const inUse = db.prepare('SELECT 1 FROM timetable_entries WHERE timeslot_id = ?').get(req.params.id);
  if (!inUse) {
    db.prepare('DELETE FROM timeslots WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/timeslots');
});

// ---------- Allocation engine ----------
router.get('/allocation', (req, res) => {
  const session = activeSession();
  let entries = [];
  if (session) {
    entries = db.prepare(`
      SELECT te.*, c.code, c.title, co.registered_count, u.name AS lecturer_name,
             v.name AS venue_name, v.capacity, ts.day, ts.start_time, ts.end_time
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      LEFT JOIN venues v ON v.id = te.venue_id
      LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
      WHERE co.session_id = ?
      ORDER BY co.registered_count DESC
    `).all(session.id);
  }
  res.render('admin/allocation', { title: 'Allocation engine', session, entries });
});

router.post('/allocation/run', (req, res) => {
  const session = activeSession();
  if (session) runAllocationEngine(session.id);
  res.redirect('/admin/allocation');
});

// ---------- Publish queue (registrar final action) ----------
// ---------- Master timetable grid (university-wide) ----------
router.get('/timetable', (req, res) => {
  const session = activeSession();
  const bands = db.prepare('SELECT DISTINCT start_time, end_time FROM timeslots ORDER BY start_time').all();
  let entries = [];
  if (session) {
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
      WHERE co.session_id = ? AND te.status != 'rejected' AND te.timeslot_id IS NOT NULL
      ORDER BY c.code
    `).all(session.id);
  }
  res.render('admin/timetable', { title: 'Master timetable', session, entries, bands });
});

router.get('/publish', (req, res) => {
  const session = activeSession();
  let entries = [];
  if (session) {
    entries = db.prepare(`
      SELECT te.*, c.code, c.title, v.name AS venue_name, ts.day, ts.start_time, ts.end_time
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      LEFT JOIN venues v ON v.id = te.venue_id
      LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
      WHERE co.session_id = ? AND te.status = 'final'
    `).all(session.id);
  }
  res.render('admin/publish', { title: 'Publish queue', session, entries });
});

router.post('/publish/:entryId', (req, res) => {
  try {
    approve(req.params.entryId, 'admin', req.session.user.id);
  } catch (e) { /* ignore */ }
  res.redirect('/admin/publish');
});

module.exports = router;
