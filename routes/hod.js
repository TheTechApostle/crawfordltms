const express = require('express');
const router = express.Router();
const { db } = require('../config/db');
const { requireRole, flash } = require('../middleware/auth');
const access = require('../services/courseAccess');
const { approve, reject } = require('../services/approvalService');

router.use(requireRole('hod'));

function activeSession() {
  return db.prepare('SELECT * FROM academic_sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
}
function myDept(req) {
  return db.prepare(`
    SELECT d.*, c.name AS college_name FROM departments d
    LEFT JOIN colleges c ON c.id = d.college_id
    WHERE d.id = ?
  `).get(req.session.user.department_id);
}
// True if a given timetable entry belongs to this HOD's own department —
// checked before approve/reject so an HOD can't act outside their own
// department even if they guess another entry's id (mirrors the same
// check on the Dean side for college).
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
  let pendingCount = 0, courseCount = 0, pendingCourseCount = 0, programmeCount = 0, pendingAllocationCount = 0;
  if (dept) {
    courseCount = db.prepare('SELECT COUNT(*) c FROM courses WHERE department_id = ?').get(dept.id).c;
    pendingCourseCount = db.prepare("SELECT COUNT(*) c FROM courses WHERE department_id = ? AND status = 'pending'").get(dept.id).c;
    programmeCount = db.prepare('SELECT COUNT(*) c FROM programmes WHERE department_id = ?').get(dept.id).c;
  }
  if (dept && session) {
    pendingAllocationCount = db.prepare(`
      SELECT COUNT(*) c FROM course_offerings co JOIN courses c ON c.id = co.course_id
      WHERE c.department_id = ? AND co.session_id = ? AND co.allocation_status = 'pending'
    `).get(dept.id, session.id).c;
    pendingCount = db.prepare(`
      SELECT COUNT(*) c FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      WHERE c.department_id = ? AND co.session_id = ? AND ${access.CURRENT_OFFERING} AND te.status = 'lecturer_ok'
    `).get(dept.id, session.id).c;
  }
  res.render('hod/dashboard', { title: 'HOD dashboard', dept, session, pendingCount, courseCount, pendingCourseCount, programmeCount, pendingAllocationCount });
});

// ---------- Programmes (the HOD's own department only) ----------
router.get('/programmes', (req, res) => {
  const dept = myDept(req);
  let programmes = [], coordinators = [];
  if (dept) {
    programmes = db.prepare(`
      SELECT p.*, cu.name AS coordinator_name,
             (SELECT COUNT(*) FROM course_programmes cp WHERE cp.programme_id = p.id) AS course_count
      FROM programmes p LEFT JOIN users cu ON cu.id = p.coordinator_id
      WHERE p.department_id = ? ORDER BY p.name
    `).all(dept.id);
    // Any coordinator account can be seated on one of this department's programmes —
    // coordinators may run programmes across departments.
    coordinators = db.prepare(`
      SELECT u.id, u.name, u.email, d.code AS dept_code FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.role = 'coordinator' ORDER BY u.name
    `).all();
  }
  res.render('hod/programmes', { title: 'Programmes', dept, programmes, coordinators });
});

router.post('/programmes', (req, res) => {
  const dept = myDept(req);
  if (!dept) return res.redirect('/hod/programmes');
  const { name, code } = req.body;
  const mode = access.MODES[req.body.study_mode] ? req.body.study_mode : 'full_time';
  try {
    db.prepare('INSERT INTO programmes (name, code, department_id, study_mode) VALUES (?, ?, ?, ?)').run(name, code, dept.id, mode);
    access.syncAllScopes();
  } catch (e) { flash(req, 'error', 'That programme code is already used in your department.'); }
  res.redirect('/hod/programmes');
});

router.post('/programmes/:id/edit', (req, res) => {
  const dept = myDept(req);
  const programme = dept && db.prepare('SELECT * FROM programmes WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!programme) return res.redirect('/hod/programmes');
  const { name, code } = req.body;
  try {
    db.prepare('UPDATE programmes SET name = ?, code = ?, study_mode = ? WHERE id = ?')
      .run(name, code, access.MODES[req.body.study_mode] ? req.body.study_mode : programme.study_mode, programme.id);
  } catch (e) { flash(req, 'error', 'That programme code is already used in your department.'); }
  res.redirect('/hod/programmes');
});

// Seat, change or remove a programme's coordinator. With no coordinator the
// HOD handles that programme's courses and lecturer allocation directly —
// so clearing this is how the HOD takes over while a coordinator is away.
router.post('/programmes/:id/coordinator', (req, res) => {
  const dept = myDept(req);
  const programme = dept && db.prepare('SELECT * FROM programmes WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!programme) return res.redirect('/hod/programmes');
  const cid = req.body.coordinator_id ? Number(req.body.coordinator_id) : null;
  if (cid && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'coordinator'").get(cid)) {
    flash(req, 'error', 'Pick a Programme Coordinator account.');
  } else {
    db.prepare('UPDATE programmes SET coordinator_id = ? WHERE id = ?').run(cid, programme.id);
    flash(req, 'success', cid ? `Coordinator set for ${programme.name}.` : `${programme.name} now has no coordinator — you handle its courses and allocation directly.`);
  }
  res.redirect('/hod/programmes');
});

router.post('/programmes/:id/delete', (req, res) => {
  const dept = myDept(req);
  const programme = dept && db.prepare('SELECT * FROM programmes WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!programme) return res.redirect('/hod/programmes');
  const inUse = db.prepare("SELECT 1 FROM course_programmes WHERE programme_id = ? AND source = 'manual'").get(programme.id)
    || db.prepare('SELECT 1 FROM courses WHERE programme_id = ?').get(programme.id);
  if (!inUse) {
    db.prepare("DELETE FROM course_programmes WHERE programme_id = ? AND source = 'scope'").run(programme.id);
    db.prepare('DELETE FROM programmes WHERE id = ?').run(programme.id);
  } else {
    flash(req, 'error', 'That programme still has courses — move or remove them first.');
  }
  res.redirect('/hod/programmes');
});

// ---------- Courses (create/edit/delete proposals; Dean approves) ----------
// The HOD handles a course directly when its programme has no coordinator (or
// it has no programme). Where a coordinator runs the programme, its courses
// show here for visibility but the coordinator adds and edits them.
router.get('/courses', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
  let courses = [], programmes = [], sharedIn = [], linked = {}, scopes = {};
  if (dept) {
    courses = db.prepare(`
      SELECT c.*, p.name AS programme_name, cu.name AS coordinator_name,
             (SELECT COUNT(*) FROM course_offerings co WHERE co.course_id = c.id AND co.session_id = ?) AS offered_this_session
      FROM courses c
      LEFT JOIN programmes p ON p.id = c.programme_id
      LEFT JOIN users cu ON cu.id = p.coordinator_id AND cu.role = 'coordinator'
      WHERE c.department_id = ?
      ORDER BY c.code
    `).all(session ? session.id : 0, dept.id);
    courses.forEach(c => { c.managed_by = c.coordinator_name ? 'coordinator' : 'hod'; });
    programmes = db.prepare(`
      SELECT p.*, cu.name AS coordinator_name FROM programmes p
      LEFT JOIN users cu ON cu.id = p.coordinator_id AND cu.role = 'coordinator'
      WHERE p.department_id = ? ORDER BY p.name
    `).all(dept.id);
    // Courses owned by other departments (possibly other colleges) that one of this department's programmes also offers.
    sharedIn = db.prepare(`
      SELECT DISTINCT c.id, c.code, c.title, c.level, c.scope, d.name AS dept_name, co.name AS college_name, p.code AS programme_code, cp.programme_id
      FROM course_programmes cp
      JOIN programmes p ON p.id = cp.programme_id AND p.department_id = ?
      JOIN courses c ON c.id = cp.course_id AND c.department_id != ?
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN colleges co ON co.id = d.college_id
      ORDER BY c.code
    `).all(dept.id, dept.id);
    // University-/department-wide courses apply to every programme: show them once, not once per programme.
    const seenShared = new Set();
    sharedIn = sharedIn.filter(c => {
      if (c.scope === 'programmes') return true;
      if (seenShared.has(c.id)) return false;
      seenShared.add(c.id); c.programme_code = c.scope === 'all' ? 'all programmes' : 'whole department'; c.programme_id = null;
      return true;
    });
    linked = access.programmesByCourse(courses.map(c => c.id));
    scopes = access.scopesByCourse(courses.map(c => c.id));
  }
  res.render('hod/courses', {
    title: 'Courses', dept, session, courses, programmes, sharedIn, linked, scopes,
    allProgrammes: access.allProgrammesWithCollege(),
  });
});

// A programme the HOD may use directly: in their department and without a coordinator.
function hodProgramme(dept, programmeId) {
  if (!programmeId) return { id: null };
  const p = db.prepare(`
    SELECT p.*, cu.id AS coord FROM programmes p
    LEFT JOIN users cu ON cu.id = p.coordinator_id AND cu.role = 'coordinator'
    WHERE p.id = ? AND p.department_id = ?
  `).get(programmeId, dept.id);
  if (!p) return null;
  return p.coord ? { coordinated: true, name: p.name } : p;
}
function hodManages(dept, course) {
  return course && course.department_id === dept.id && access.managerRole(course) === 'hod';
}

router.post('/courses', (req, res) => {
  const dept = myDept(req);
  if (!dept) return res.redirect('/hod/courses');
  const { code, title, credit_units, programme_id, level, expected_class_size } = req.body;
  const ctype = access.normalizeCourseType(req.body.course_type) || 'compulsory';
  const sem = [1, 2, 3].includes(Number(req.body.semester)) ? Number(req.body.semester) : 1;
  const prog = hodProgramme(dept, programme_id);
  if (!prog || prog.coordinated) {
    flash(req, 'error', prog ? `${prog.name} has a Programme Coordinator, who adds its courses. Remove the coordinator first if you need to step in.` : 'Pick a programme from your own department.');
    return res.redirect('/hod/courses');
  }
  try {
    const r = db.prepare(`
      INSERT INTO courses (code, title, credit_units, department_id, programme_id, level, expected_class_size, course_type, semester, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?)
    `).run((code || '').trim(), (title || '').trim(), credit_units || 3, dept.id, prog.id, level, expected_class_size || null, ctype, sem, req.session.user.id);
    access.applySharing({ id: r.lastInsertRowid, programme_id: prog.id }, req.body, req.session.user.id);
    flash(req, 'success', `${code} submitted to the Dean for approval.`);
  } catch (e) {
    flash(req, 'error', /UNIQUE/.test(e.message) ? `A course with the code ${code} already exists.` : e.message);
  }
  res.redirect('/hod/courses');
});

router.post('/courses/:id/edit', (req, res) => {
  const dept = myDept(req);
  const course = dept && db.prepare('SELECT * FROM courses WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  // Only editable while it hasn't been signed off yet — once approved, it's
  // locked here (the registrar can still adjust it directly if needed).
  if (!course || !['pending', 'rejected'].includes(course.status) || !hodManages(dept, course)) {
    flash(req, 'error', 'That course can\'t be edited here — it\'s approved, or its programme\'s coordinator runs it.');
    return res.redirect('/hod/courses');
  }
  const { code, title, credit_units, programme_id, level, expected_class_size } = req.body;
  const ctype = access.normalizeCourseType(req.body.course_type) || 'compulsory';
  const sem = [1, 2, 3].includes(Number(req.body.semester)) ? Number(req.body.semester) : 1;
  const prog = hodProgramme(dept, programme_id);
  if (!prog || prog.coordinated) {
    flash(req, 'error', 'Pick a programme from your department that has no coordinator (or none).');
    return res.redirect('/hod/courses');
  }
  // Editing a rejected proposal resubmits it — back to pending, reason cleared.
  try {
    db.prepare(`
      UPDATE courses SET code = ?, title = ?, credit_units = ?, programme_id = ?, level = ?, expected_class_size = ?, course_type = ?, semester = ?,
             status = 'pending', reject_reason = NULL
      WHERE id = ?
    `).run((code || '').trim(), (title || '').trim(), credit_units || 3, prog.id, level, expected_class_size || null, ctype, sem, course.id);
    if (prog.id) access.linkCourseToProgramme(course.id, prog.id, req.session.user.id);
  } catch (e) {
    flash(req, 'error', /UNIQUE/.test(e.message) ? `The code ${code} is already used by another course.` : e.message);
  }
  res.redirect('/hod/courses');
});

router.post('/courses/:id/programmes', (req, res) => {
  const dept = myDept(req);
  const course = dept && db.prepare('SELECT * FROM courses WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!hodManages(dept, course)) flash(req, 'error', 'You can\'t change which programmes offer that course — its coordinator runs it.');
  else {
    access.applySharing(course, req.body, req.session.user.id);
    flash(req, 'success', `Programmes offering ${course.code} updated.`);
  }
  res.redirect('/hod/courses');
});

// Level/semester each other programme takes a course the HOD runs at (blank = same as the course's own).
router.post('/courses/:id/placements', (req, res) => {
  const dept = myDept(req);
  const course = dept && db.prepare('SELECT * FROM courses WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!hodManages(dept, course)) flash(req, 'error', 'You can\'t change levels/semesters for that course.');
  else {
    db.prepare('SELECT programme_id FROM course_programmes WHERE course_id = ?').all(course.id).forEach(l => {
      if (l.programme_id !== course.programme_id && ('level_' + l.programme_id) in req.body)
        access.setPlacement(course.id, l.programme_id, req.body['level_' + l.programme_id], req.body['semester_' + l.programme_id]);
    });
    flash(req, 'success', `Levels and semesters updated for ${course.code}.`);
  }
  res.redirect('/hod/courses');
});

// Add an existing (approved) course from anywhere in the catalogue to one of this department's programmes.
router.post('/courses/link', (req, res) => {
  const dept = myDept(req);
  const prog = dept && hodProgramme(dept, req.body.programme_id);
  const course = db.prepare('SELECT * FROM courses WHERE code = ? COLLATE NOCASE').get((req.body.code || '').trim());
  if (!prog || !prog.id || prog.coordinated) flash(req, 'error', 'Pick one of your department\'s programmes that has no coordinator.');
  else if (!course) flash(req, 'error', `No course with code "${req.body.code}" exists.`);
  else if (course.status !== 'approved') flash(req, 'error', `${course.code} hasn't been approved yet.`);
  else {
    access.linkCourseToProgramme(course.id, prog.id, req.session.user.id);
    // This programme may take it at a different level / semester than its owner does.
    if (req.body.level || req.body.semester) access.setPlacement(course.id, prog.id, req.body.level, req.body.semester);
    flash(req, 'success', `${course.code} is now offered by ${prog.name} as well.`);
  }
  res.redirect('/hod/courses');
});

router.post('/courses/:id/unlink', (req, res) => {
  const dept = myDept(req);
  const prog = dept && db.prepare('SELECT * FROM programmes WHERE id = ? AND department_id = ?').get(req.body.programme_id, dept.id);
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (course && course.scope !== 'programmes') {
    flash(req, 'error', `${course.code} is offered ${course.scope === 'all' ? 'to every programme' : 'to whole departments'} by its owner, so it can't be removed from one programme.`);
  } else if (prog && course && course.department_id !== dept.id) {
    db.prepare('DELETE FROM course_programmes WHERE course_id = ? AND programme_id = ?').run(course.id, prog.id);
    flash(req, 'success', `${course.code} removed from ${prog.name}.`);
  }
  res.redirect('/hod/courses');
});

// The department can delete any of its own courses, including approved ones
// already offered. Courses with student registrations or a published
// timetable are kept and reported.
router.post('/courses/:id/delete', (req, res) => {
  const dept = myDept(req);
  const course = dept && db.prepare('SELECT * FROM courses WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!course) return res.redirect('/hod/courses');
  const r = access.deleteCourses([course.id]);
  flash(req, r.deleted.length ? 'success' : 'error', r.deleted.length ? `${course.code} deleted.` : `${course.code} was kept: ${r.blocked.map(b => b.reason).join('; ')}.`);
  res.redirect('/hod/courses');
});

router.post('/courses/bulk-delete', (req, res) => {
  const dept = myDept(req);
  if (!dept) return res.redirect('/hod/courses');
  const wanted = [].concat(req.body.course_ids || []).map(Number).filter(Boolean);
  const own = wanted.length
    ? db.prepare(`SELECT id FROM courses WHERE department_id = ? AND id IN (${wanted.map(() => '?').join(',')})`).all(dept.id, ...wanted).map(r => r.id)
    : [];
  if (!own.length) flash(req, 'error', 'Tick the courses you want to delete first.');
  else {
    const r = access.deleteCourses(own);
    flash(req, r.deleted.length ? 'success' : 'error', access.deleteSummary(r));
  }
  res.redirect('/hod/courses');
});

router.post('/courses/:id/offer', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
  const course = dept && db.prepare('SELECT * FROM courses WHERE id = ? AND department_id = ?').get(req.params.id, dept.id);
  if (!course || course.status !== 'approved' || !session) return res.redirect('/hod/courses');
  const made = access.offerCourse(course.id, session.id);
  const label = access.makeSemLabel();
  flash(req, 'success', made.length
    ? `${course.code} offered: ${made.map(m => `${access.MODES[m.study_mode]} · ${label(m.study_mode, m.semester)}`).join(', ')}.`
    : `${course.code} is already offered for every study mode and semester it runs in.`);
  res.redirect('/hod/courses');
});

// ---------- Lecturer allocation ----------
// HOD allocates directly for courses whose programme has no coordinator
// (immediately effective). For coordinator-run programmes the coordinator
// proposes and the HOD approves on the next page. The Dean only views.
router.get('/assign', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
  let offerings = [];
  if (dept && session) {
    offerings = db.prepare(`
      SELECT co.*, c.code, c.title, c.programme_id, p.code AS programme_code,
             cu.name AS coordinator_name, lu.name AS lecturer_name, pu.name AS proposed_name
      FROM course_offerings co
      JOIN courses c ON c.id = co.course_id
      LEFT JOIN programmes p ON p.id = c.programme_id
      LEFT JOIN users cu ON cu.id = p.coordinator_id AND cu.role = 'coordinator'
      LEFT JOIN users lu ON lu.id = co.lecturer_id
      LEFT JOIN users pu ON pu.id = co.proposed_lecturer_id
      WHERE c.department_id = ? AND co.session_id = ?
      ORDER BY c.code
    `).all(dept.id, session.id);
  }
  const lecturers = dept ? access.eligibleLecturers(dept.id) : [];
  res.render('hod/assign', { title: 'Assign lecturers', dept, session, offerings, lecturers });
});

router.post('/assign/:offeringId', (req, res) => {
  const dept = myDept(req);
  const o = dept && access.getOffering(req.params.offeringId);
  if (!o || o.department_id !== dept.id) return res.redirect('/hod/assign');
  if (access.managerRole(o) === 'coordinator') {
    flash(req, 'error', `${o.code} belongs to a programme with a coordinator — they propose the lecturer and you approve it under "Allocation approvals".`);
    return res.redirect('/hod/assign');
  }
  const lecturerId = req.body.lecturer_id ? Number(req.body.lecturer_id) : null;
  if (lecturerId && !access.isEligibleLecturer(lecturerId, dept.id)) {
    flash(req, 'error', 'Pick a lecturer from your own department.');
    return res.redirect('/hod/assign');
  }
  access.allocateDirect(o.id, lecturerId, req.session.user.id);
  flash(req, 'success', lecturerId ? `Lecturer allocated to ${o.code}.` : `${o.code} is unallocated.`);
  res.redirect('/hod/assign');
});

// ---------- Allocation approvals (coordinator proposals) ----------
function pendingAllocations(deptId, sessionId) {
  return db.prepare(`
    SELECT co.*, c.code, c.title, c.level, p.name AS programme_name,
           pu.name AS proposed_name, bu.name AS proposed_by, lu.name AS current_lecturer
    FROM course_offerings co
    JOIN courses c ON c.id = co.course_id
    LEFT JOIN programmes p ON p.id = c.programme_id
    LEFT JOIN users pu ON pu.id = co.proposed_lecturer_id
    LEFT JOIN users bu ON bu.id = co.allocation_by
    LEFT JOIN users lu ON lu.id = co.lecturer_id
    WHERE c.department_id = ? AND co.session_id = ? AND co.allocation_status = 'pending'
    ORDER BY c.code
  `).all(deptId, sessionId);
}

router.get('/allocations', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
  const pending = dept && session ? pendingAllocations(dept.id, session.id) : [];
  res.render('hod/allocations', { title: 'Allocation approvals', dept, session, pending });
});

router.post('/allocations/:offeringId/approve', (req, res) => {
  const dept = myDept(req);
  const o = dept && access.getOffering(req.params.offeringId);
  if (o && o.department_id === dept.id && access.approveAllocation(o.id, req.session.user.id)) {
    flash(req, 'success', `Allocation for ${o.code} approved.`);
  }
  res.redirect('/hod/allocations');
});

router.post('/allocations/:offeringId/reject', (req, res) => {
  const dept = myDept(req);
  const o = dept && access.getOffering(req.params.offeringId);
  if (o && o.department_id === dept.id && access.rejectAllocation(o.id, req.session.user.id, (req.body.reason || '').trim())) {
    flash(req, 'success', `Allocation for ${o.code} sent back to the coordinator.`);
  }
  res.redirect('/hod/allocations');
});

// Approve every pending proposal in one go.
router.post('/allocations/approve-all', (req, res) => {
  const dept = myDept(req);
  const session = activeSession();
  if (dept && session) {
    const n = pendingAllocations(dept.id, session.id).filter(o => access.approveAllocation(o.id, req.session.user.id)).length;
    flash(req, 'success', `${n} allocation(s) approved.`);
  }
  res.redirect('/hod/allocations');
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
      WHERE c.department_id = ? AND co.session_id = ? AND ${access.CURRENT_OFFERING} AND te.status = 'lecturer_ok'
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
      WHERE c.department_id = ? AND co.session_id = ? AND ${access.CURRENT_OFFERING} AND te.status != 'rejected'
    `).all(dept.id, session.id);
  }
  res.render('hod/timetable', { title: 'Department timetable', dept, session, entries, bands });
});

module.exports = router;
