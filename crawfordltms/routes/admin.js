const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
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
    colleges: db.prepare('SELECT COUNT(*) c FROM colleges').get().c,
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

// ---------- Colleges ----------
router.get('/colleges', (req, res) => {
  const colleges = db.prepare(`
    SELECT co.*, u.name AS dean_name,
           (SELECT COUNT(*) FROM departments d WHERE d.college_id = co.id) AS dept_count
    FROM colleges co
    LEFT JOIN users u ON u.id = co.dean_id
    ORDER BY co.name
  `).all();
  const deans = db.prepare("SELECT * FROM users WHERE role='dean'").all();
  res.render('admin/colleges', { title: 'Colleges', colleges, deans });
});

router.post('/colleges', (req, res) => {
  const { name, code, dean_id } = req.body;
  const result = db.prepare('INSERT INTO colleges (name, code, dean_id) VALUES (?, ?, ?)').run(name, code, dean_id || null);
  // Keep the Dean's own college_id in sync — that's what actually scopes
  // their approval queue, not the reverse pointer on the college row.
  if (dean_id) {
    db.prepare('UPDATE users SET college_id = ? WHERE id = ?').run(result.lastInsertRowid, dean_id);
  }
  res.redirect('/admin/colleges');
});

router.post('/colleges/:id/edit', (req, res) => {
  const { name, code, dean_id } = req.body;
  db.prepare('UPDATE colleges SET name = ?, code = ?, dean_id = ? WHERE id = ?')
    .run(name, code, dean_id || null, req.params.id);
  // Reassigning the dean is a real change of authority, not just a label —
  // keep the newly-picked dean's own college_id in sync so their approval
  // queue actually follows. (A dean removed from this college keeps their
  // old college_id until reassigned elsewhere — we never null someone's
  // access out from under an unrelated edit.)
  if (dean_id) {
    db.prepare('UPDATE users SET college_id = ? WHERE id = ?').run(req.params.id, dean_id);
  }
  res.redirect('/admin/colleges');
});

router.post('/colleges/:id/delete', (req, res) => {
  const hasDepartments = db.prepare('SELECT 1 FROM departments WHERE college_id = ?').get(req.params.id);
  if (!hasDepartments) {
    db.prepare('DELETE FROM colleges WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/colleges');
});

// ---------- Departments ----------
router.get('/departments', (req, res) => {
  const departments = db.prepare(`
    SELECT d.*, u.name AS hod_name, co.name AS college_name,
           (SELECT COUNT(*) FROM courses c WHERE c.department_id = d.id) AS course_count,
           (SELECT COUNT(*) FROM users du WHERE du.department_id = d.id) AS user_count,
           (SELECT COUNT(*) FROM programmes p WHERE p.department_id = d.id) AS programme_count
    FROM departments d
    LEFT JOIN users u ON u.id = d.hod_id
    LEFT JOIN colleges co ON co.id = d.college_id
    ORDER BY d.name
  `).all();
  const hods = db.prepare("SELECT * FROM users WHERE role='hod'").all();
  const colleges = db.prepare('SELECT * FROM colleges ORDER BY name').all();
  res.render('admin/departments', { title: 'Departments', departments, hods, colleges });
});

router.post('/departments', (req, res) => {
  const { name, code, college_id, hod_id } = req.body;
  db.prepare('INSERT INTO departments (name, code, college_id, hod_id) VALUES (?, ?, ?, ?)')
    .run(name, code, college_id || null, hod_id || null);
  res.redirect('/admin/departments');
});

router.post('/departments/:id/edit', (req, res) => {
  const { name, code, college_id, hod_id } = req.body;
  db.prepare('UPDATE departments SET name = ?, code = ?, college_id = ?, hod_id = ? WHERE id = ?')
    .run(name, code, college_id || null, hod_id || null, req.params.id);
  // Same reasoning as college/dean above: reassigning the HOD here is meant
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
       OR EXISTS (SELECT 1 FROM programmes WHERE department_id = ?)
  `).get(req.params.id, req.params.id, req.params.id);
  if (!inUse) {
    db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/departments');
});

// ---------- Programmes ----------
router.get('/programmes', (req, res) => {
  const programmes = db.prepare(`
    SELECT p.*, d.name AS dept_name, co.name AS college_name,
           (SELECT COUNT(*) FROM courses c WHERE c.programme_id = p.id) AS course_count
    FROM programmes p
    JOIN departments d ON d.id = p.department_id
    LEFT JOIN colleges co ON co.id = d.college_id
    ORDER BY d.name, p.name
  `).all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.render('admin/programmes', { title: 'Programmes', programmes, departments });
});

router.post('/programmes', (req, res) => {
  const { name, code, department_id } = req.body;
  db.prepare('INSERT INTO programmes (name, code, department_id) VALUES (?, ?, ?)')
    .run(name, code, department_id);
  res.redirect('/admin/programmes');
});

router.post('/programmes/:id/edit', (req, res) => {
  const { name, code, department_id } = req.body;
  db.prepare('UPDATE programmes SET name = ?, code = ?, department_id = ? WHERE id = ?')
    .run(name, code, department_id, req.params.id);
  res.redirect('/admin/programmes');
});

router.post('/programmes/:id/delete', (req, res) => {
  const inUse = db.prepare('SELECT 1 FROM courses WHERE programme_id = ?').get(req.params.id);
  if (!inUse) {
    db.prepare('DELETE FROM programmes WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/programmes');
});

// ---------- Courses ----------
router.get('/courses', (req, res) => {
  const session = activeSession();
  const courses = db.prepare(`
    SELECT c.*, d.name AS dept_name, p.name AS programme_name,
           (SELECT COUNT(*) FROM course_offerings co WHERE co.course_id = c.id) AS offering_count
    FROM courses c
    JOIN departments d ON d.id = c.department_id
    LEFT JOIN programmes p ON p.id = c.programme_id
    ORDER BY c.code
  `).all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const programmes = db.prepare('SELECT * FROM programmes ORDER BY name').all();
  let offerings = [];
  if (session) {
    offerings = db.prepare(`
      SELECT co.*, c.code, c.title, u.name AS lecturer_name FROM course_offerings co
      JOIN courses c ON c.id = co.course_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      WHERE co.session_id = ?
    `).all(session.id);
  }
  res.render('admin/courses', { title: 'Courses', courses, departments, programmes, session, offerings });
});

router.post('/courses', (req, res) => {
  const { code, title, credit_units, department_id, programme_id, level, expected_class_size } = req.body;
  // The registrar has full authority — a course they add goes straight to
  // 'approved', skipping the Dean review that an HOD-proposed course needs.
  db.prepare(`
    INSERT INTO courses (code, title, credit_units, department_id, programme_id, level, expected_class_size, status, created_by)
    VALUES (?,?,?,?,?,?,?,'approved',?)
  `).run(code, title, credit_units || 3, department_id, programme_id || null, level, expected_class_size || null, req.session.user.id);
  res.redirect('/admin/courses');
});

router.post('/courses/:id/edit', (req, res) => {
  const { code, title, credit_units, department_id, programme_id, level, expected_class_size } = req.body;
  db.prepare(`
    UPDATE courses SET code = ?, title = ?, credit_units = ?, department_id = ?, programme_id = ?, level = ?, expected_class_size = ?
    WHERE id = ?
  `).run(code, title, credit_units || 3, department_id, programme_id || null, level, expected_class_size || null, req.params.id);
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
  // Real registrations take priority: a course with actual enrollments this
  // session ignores the HOD's estimate and runs on the live count as usual.
  // Anything with zero registrations so far but an HOD-supplied
  // expected_class_size gets a *provisional* allocation instead, so venues
  // and a draft timetable exist immediately rather than everything sitting
  // idle until every student has registered. Provisional entries are
  // clearly flagged (is_provisional) and get swept aside automatically the
  // moment real registrations come in for that course.
  if (session) runAllocationEngine(session.id, { useEstimates: true });
  res.redirect('/admin/allocation');
});

// ---------- Publish queue (registrar final action) ----------
// ---------- Master timetable grid (university-wide, filterable) ----------
router.get('/timetable', (req, res) => {
  const session = activeSession();
  const bands = db.prepare('SELECT DISTINCT start_time, end_time FROM timeslots ORDER BY start_time').all();
  const colleges = db.prepare('SELECT * FROM colleges ORDER BY name').all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const collegeId = req.query.college_id || '';
  const departmentId = req.query.department_id || '';
  let entries = [];
  if (session) {
    let sql = `
      SELECT te.*, c.code, c.title, d.name AS dept_name, co2.name AS college_name,
             u.name AS lecturer_name, v.name AS venue_name, v.capacity,
             ts.day, ts.start_time, ts.end_time, co.registered_count
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN colleges co2 ON co2.id = d.college_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      LEFT JOIN venues v ON v.id = te.venue_id
      LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
      WHERE co.session_id = ? AND te.status != 'rejected' AND te.timeslot_id IS NOT NULL
    `;
    const params = [session.id];
    if (departmentId) {
      sql += ' AND d.id = ?';
      params.push(departmentId);
    } else if (collegeId) {
      sql += ' AND d.college_id = ?';
      params.push(collegeId);
    }
    sql += ' ORDER BY c.code';
    entries = db.prepare(sql).all(...params);
  }
  res.render('admin/timetable', { title: 'Master timetable', session, entries, bands, colleges, departments, collegeId, departmentId });
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

// ---------- Students: bulk import ----------
// Admin/Registrar can bulk-create student accounts from a pasted CSV
// (name,email,department_code,level[,password]) alongside normal
// self-signup at /register/student — the two are not mutually exclusive.
router.get('/students', (req, res) => {
  const students = db.prepare(`
    SELECT u.*, d.name AS dept_name FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.role = 'student' ORDER BY u.created_at DESC
  `).all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  res.render('admin/students', { title: 'Students', students, departments, result: null });
});

router.post('/students/import', (req, res) => {
  const { csv, default_password } = req.body;
  const pw = default_password && default_password.length >= 8 ? default_password : 'password123';
  const lines = (csv || '').split('\n').map(l => l.trim()).filter(Boolean);
  const departments = db.prepare('SELECT * FROM departments').all();
  const deptByCode = {};
  departments.forEach(d => { deptByCode[d.code.toLowerCase()] = d; });

  const created = [];
  const errors = [];
  const insert = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, department_id, level)
    VALUES (?, ?, ?, 'student', ?, ?)
  `);
  const existsStmt = db.prepare('SELECT id FROM users WHERE email = ?');

  lines.forEach((line, i) => {
    const parts = line.split(',').map(p => p.trim());
    const [name, email, deptCode, level] = parts;
    if (!name || !email || !deptCode || !level) {
      errors.push(`Line ${i + 1}: expected "name,email,department_code,level" — got "${line}"`);
      return;
    }
    const dept = deptByCode[deptCode.toLowerCase()];
    if (!dept) {
      errors.push(`Line ${i + 1}: unknown department code "${deptCode}"`);
      return;
    }
    if (existsStmt.get(email.toLowerCase())) {
      errors.push(`Line ${i + 1}: ${email} is already registered`);
      return;
    }
    const hash = bcrypt.hashSync(pw, 10);
    insert.run(name, email.toLowerCase(), hash, dept.id, Number(level));
    created.push({ name, email });
  });

  const students = db.prepare(`
    SELECT u.*, d.name AS dept_name FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.role = 'student' ORDER BY u.created_at DESC
  `).all();
  res.render('admin/students', {
    title: 'Students', students, departments,
    result: { created, errors, defaultPassword: pw },
  });
});

router.post('/students/:id/delete', (req, res) => {
  const hasEnrollments = db.prepare('SELECT 1 FROM enrollments WHERE student_id = ?').get(req.params.id);
  if (!hasEnrollments) {
    db.prepare("DELETE FROM users WHERE id = ? AND role = 'student'").run(req.params.id);
  }
  res.redirect('/admin/students');
});

module.exports = router;
