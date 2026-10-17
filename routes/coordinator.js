const express = require('express');
const router = express.Router();
const { db } = require('../config/db');
const { requireRole, flash } = require('../middleware/auth');
const access = require('../services/courseAccess');

router.use(requireRole('coordinator'));

const activeSession = access.activeSession;

function myProgrammes(req) {
  return access.programmesCoordinatedBy(req.session.user.id);
}
// The programme this page is currently working on (?programme_id=, defaulting to the first one).
function pickProgramme(req, programmes) {
  const wanted = Number((req.query && req.query.programme_id) || (req.body && req.body.programme_id));
  return programmes.find(p => p.id === wanted) || programmes[0] || null;
}
function back(req, path, programme) {
  return `${path}${programme ? `?programme_id=${programme.id}` : ''}`;
}
// A course this coordinator runs: its HOME programme is one of theirs.
function managedCourse(req, courseId) {
  const ids = myProgrammes(req).map(p => p.id);
  const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
  return c && c.programme_id && ids.includes(c.programme_id) ? c : null;
}

// ---------- Dashboard ----------
router.get('/', (req, res) => {
  const programmes = myProgrammes(req);
  const session = activeSession();
  const ids = programmes.map(p => p.id);
  const inList = ids.length ? ids.map(() => '?').join(',') : 'NULL';
  const count = (sql, ...extra) => ids.length ? db.prepare(sql).get(...ids, ...extra).c : 0;
  const stats = {
    courses: count(`SELECT COUNT(*) c FROM courses WHERE programme_id IN (${inList})`),
    pendingCourses: count(`SELECT COUNT(*) c FROM courses WHERE programme_id IN (${inList}) AND status = 'pending'`),
    awaitingHod: session ? count(`
      SELECT COUNT(*) c FROM course_offerings co JOIN courses c ON c.id = co.course_id
      WHERE c.programme_id IN (${inList}) AND co.session_id = ? AND co.allocation_status = 'pending'`, session.id) : 0,
    rejected: session ? count(`
      SELECT COUNT(*) c FROM course_offerings co JOIN courses c ON c.id = co.course_id
      WHERE c.programme_id IN (${inList}) AND co.session_id = ? AND co.allocation_status = 'rejected'`, session.id) : 0,
    unallocated: session ? count(`
      SELECT COUNT(*) c FROM course_offerings co JOIN courses c ON c.id = co.course_id
      WHERE c.programme_id IN (${inList}) AND co.session_id = ? AND co.lecturer_id IS NULL AND co.allocation_status IN ('none','rejected')`, session.id) : 0,
  };
  res.render('coordinator/dashboard', { title: 'Programme Coordinator dashboard', programmes, session, stats });
});

// ---------- Courses ----------
router.get('/courses', (req, res) => {
  const programmes = myProgrammes(req);
  const programme = pickProgramme(req, programmes);
  const session = activeSession();
  let courses = [], linked = {}, scopes = {};
  if (programme) {
    courses = db.prepare(`
      SELECT c.*, d.name AS dept_name, d.code AS dept_code, hp.code AS home_programme_code,
             (SELECT COUNT(*) FROM course_offerings co WHERE co.course_id = c.id AND co.session_id = ?) AS offered_this_session
      FROM course_programmes cp
      JOIN courses c ON c.id = cp.course_id
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN programmes hp ON hp.id = c.programme_id
      WHERE cp.programme_id = ?
      ORDER BY c.level, c.code
    `).all(session ? session.id : 0, programme.id);
    linked = access.programmesByCourse(courses.map(c => c.id));
    scopes = access.scopesByCourse(courses.map(c => c.id));
  }
  res.render('coordinator/courses', {
    title: 'Programme courses', programmes, programme, session, courses, linked, scopes,
    allProgrammes: access.allProgrammesWithCollege(),
  });
});

router.post('/courses', (req, res) => {
  const programmes = myProgrammes(req);
  const programme = pickProgramme(req, programmes);
  if (!programme) return res.redirect('/coordinator/courses');
  const { code, title, credit_units, level, expected_class_size } = req.body;
  try {
    // Owned by the programme's department, home programme = this one, and — like
    // an HOD proposal — it waits for the Dean of the college before it can be offered.
    const r = db.prepare(`
      INSERT INTO courses (code, title, credit_units, department_id, programme_id, level, expected_class_size, status, created_by)
      VALUES (?,?,?,?,?,?,?,'pending',?)
    `).run((code || '').trim(), (title || '').trim(), credit_units || 3, programme.department_id, programme.id,
           level, expected_class_size || null, req.session.user.id);
    access.applySharing({ id: r.lastInsertRowid, programme_id: programme.id }, req.body, req.session.user.id);
    flash(req, 'success', `${code} submitted to the Dean for approval.`);
  } catch (e) {
    flash(req, 'error', /UNIQUE/.test(e.message) ? `A course with the code ${code} already exists. If another programme owns it, use "Add an existing course" instead.` : e.message);
  }
  res.redirect(back(req, '/coordinator/courses', programme));
});

router.post('/courses/link', (req, res) => {
  const programmes = myProgrammes(req);
  const programme = pickProgramme(req, programmes);
  if (!programme) return res.redirect('/coordinator/courses');
  const course = db.prepare('SELECT * FROM courses WHERE code = ? COLLATE NOCASE').get((req.body.code || '').trim());
  if (!course) flash(req, 'error', `No course with code "${req.body.code}" exists in the catalogue.`);
  else if (course.status !== 'approved') flash(req, 'error', `${course.code} hasn't been approved yet, so it can't be added to another programme.`);
  else {
    access.linkCourseToProgramme(course.id, programme.id, req.session.user.id);
    flash(req, 'success', `${course.code} is now offered by ${programme.name} as well.`);
  }
  res.redirect(back(req, '/coordinator/courses', programme));
});

router.post('/courses/:id/edit', (req, res) => {
  const programme = pickProgramme(req, myProgrammes(req));
  const course = managedCourse(req, req.params.id);
  // Editable only while it hasn't been signed off by the Dean yet.
  if (!course || !['pending', 'rejected'].includes(course.status)) {
    flash(req, 'error', 'Only your own courses that are still pending or rejected can be edited.');
    return res.redirect(back(req, '/coordinator/courses', programme));
  }
  const { code, title, credit_units, level, expected_class_size } = req.body;
  try {
    db.prepare(`
      UPDATE courses SET code = ?, title = ?, credit_units = ?, level = ?, expected_class_size = ?,
             status = 'pending', reject_reason = NULL
      WHERE id = ?
    `).run((code || '').trim(), (title || '').trim(), credit_units || 3, level, expected_class_size || null, course.id);
    flash(req, 'success', 'Course updated' + (course.status === 'rejected' ? ' and resubmitted to the Dean.' : '.'));
  } catch (e) {
    flash(req, 'error', /UNIQUE/.test(e.message) ? `The code ${code} is already used by another course.` : e.message);
  }
  res.redirect(back(req, '/coordinator/courses', programme));
});

router.post('/courses/:id/delete', (req, res) => {
  const programme = pickProgramme(req, myProgrammes(req));
  const course = managedCourse(req, req.params.id);
  if (!course || !['pending', 'rejected'].includes(course.status)) {
    flash(req, 'error', 'Only your own pending or rejected courses can be deleted.');
  } else if (db.prepare('SELECT 1 FROM course_offerings WHERE course_id = ?').get(course.id)) {
    flash(req, 'error', 'That course has already been offered, so it can\'t be deleted.');
  } else {
    db.prepare('DELETE FROM course_programmes WHERE course_id = ?').run(course.id);
    db.prepare('DELETE FROM course_departments WHERE course_id = ?').run(course.id);
    db.prepare('DELETE FROM courses WHERE id = ?').run(course.id);
    flash(req, 'success', 'Course deleted.');
  }
  res.redirect(back(req, '/coordinator/courses', programme));
});

// Which other programmes (any college) also offer a course this coordinator runs.
router.post('/courses/:id/programmes', (req, res) => {
  const programme = pickProgramme(req, myProgrammes(req));
  const course = managedCourse(req, req.params.id);
  if (!course) flash(req, 'error', 'You can only change which programmes offer courses you run.');
  else {
    access.applySharing(course, req.body, req.session.user.id);
    flash(req, 'success', `Programmes offering ${course.code} updated.`);
  }
  res.redirect(back(req, '/coordinator/courses', programme));
});

// Stop offering a course someone else owns under this programme (the owner's home programme can't be removed).
router.post('/courses/:id/unlink', (req, res) => {
  const programme = pickProgramme(req, myProgrammes(req));
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!programme || !course) return res.redirect('/coordinator/courses');
  if (course.programme_id === programme.id) flash(req, 'error', 'This is the course\'s home programme — it can\'t be removed from it.');
  else if (course.scope !== 'programmes') flash(req, 'error', `${course.code} is offered ${course.scope === 'all' ? 'to every programme' : 'to whole departments'} by its owner, so it can't be removed from one programme.`);
  else {
    db.prepare('DELETE FROM course_programmes WHERE course_id = ? AND programme_id = ?').run(course.id, programme.id);
    flash(req, 'success', `${course.code} removed from ${programme.name}.`);
  }
  res.redirect(back(req, '/coordinator/courses', programme));
});

router.post('/courses/:id/offer', (req, res) => {
  const programme = pickProgramme(req, myProgrammes(req));
  const session = activeSession();
  const course = managedCourse(req, req.params.id);
  if (!course || course.status !== 'approved' || !session) {
    flash(req, 'error', 'Only your own approved courses can be offered, and only while a session is active.');
  } else {
    try {
      db.prepare('INSERT INTO course_offerings (course_id, session_id) VALUES (?, ?)').run(course.id, session.id);
      flash(req, 'success', `${course.code} is now offered this session — allocate a lecturer next.`);
    } catch (e) { /* already offered this session */ }
  }
  res.redirect(back(req, '/coordinator/courses', programme));
});

// ---------- Lecturer allocation (proposed here, approved by the HOD) ----------
router.get('/allocation', (req, res) => {
  const programmes = myProgrammes(req);
  const programme = pickProgramme(req, programmes);
  const session = activeSession();
  let offerings = [], shared = [], lecturers = [];
  if (programme && session) {
    const base = `
      SELECT co.*, c.code, c.title, c.level, c.department_id, c.programme_id, d.name AS dept_name,
             lu.name AS lecturer_name, pu.name AS proposed_name
      FROM course_programmes cp
      JOIN courses c ON c.id = cp.course_id
      JOIN course_offerings co ON co.course_id = c.id AND co.session_id = ?
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN users lu ON lu.id = co.lecturer_id
      LEFT JOIN users pu ON pu.id = co.proposed_lecturer_id
      WHERE cp.programme_id = ?
    `;
    const all = db.prepare(base + ' ORDER BY c.level, c.code').all(session.id, programme.id);
    // Courses whose home programme is one of mine are mine to allocate; the
    // rest are shared in from elsewhere and allocated by their owning department.
    const mine = new Set(programmes.map(p => p.id));
    offerings = all.filter(o => o.programme_id && mine.has(o.programme_id));
    shared = all.filter(o => !(o.programme_id && mine.has(o.programme_id)));
    lecturers = access.eligibleLecturers(programme.department_id);
  }
  res.render('coordinator/allocation', { title: 'Lecturer allocation', programmes, programme, session, offerings, shared, lecturers });
});

router.post('/allocation/:offeringId', (req, res) => {
  const programme = pickProgramme(req, myProgrammes(req));
  const o = access.getOffering(req.params.offeringId);
  const course = o && managedCourse(req, o.course_id);
  if (!course) {
    flash(req, 'error', 'You can only allocate lecturers to courses your programme runs.');
    return res.redirect(back(req, '/coordinator/allocation', programme));
  }
  const lecturerId = req.body.lecturer_id ? Number(req.body.lecturer_id) : null;
  if (lecturerId && !access.isEligibleLecturer(lecturerId, o.department_id)) {
    flash(req, 'error', 'Pick a lecturer from the course\'s own department.');
    return res.redirect(back(req, '/coordinator/allocation', programme));
  }
  const state = access.proposeAllocation(o.id, lecturerId, req.session.user.id);
  flash(req, 'success', state === 'pending'
    ? `Allocation for ${o.code} sent to the Head of Department for approval.`
    : `${o.code} allocation updated.`);
  res.redirect(back(req, '/coordinator/allocation', programme));
});

module.exports = router;
