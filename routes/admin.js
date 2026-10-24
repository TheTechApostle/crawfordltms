const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../config/db');
const { requireRole, flash } = require('../middleware/auth');
const { runAllocationEngine } = require('../services/allocationEngine');
const { approve, reject } = require('../services/approvalService');
const access = require('../services/courseAccess');

router.use(requireRole('admin'));

// Run a create/edit/delete, turning a database constraint failure (duplicate
// code, row still referenced, ...) into a readable message on the next page
// instead of a 500 error. Every category page below uses it, so edits fail
// politely wherever they fail.
function attempt(req, res, back, okMsg, fn) {
  try {
    const out = fn();
    if (out === false) return res.redirect(back);          // handler already flashed why
    if (okMsg) flash(req, 'success', okMsg);
  } catch (e) {
    const m = String(e.message || e);
    if (/UNIQUE constraint failed: (\w+)\.(\w+)/.test(m)) {
      const [, , col] = m.match(/UNIQUE constraint failed: (\w+)\.(\w+)/);
      flash(req, 'error', `That ${col.replace('_', ' ')} is already in use — pick a different one.`);
    } else if (/FOREIGN KEY/.test(m)) {
      flash(req, 'error', 'That record is still in use elsewhere, so it can\'t be changed that way.');
    } else {
      flash(req, 'error', m);
    }
  }
  res.redirect(back);
}

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
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} GROUP BY te.status
    `).all(session.id);
    rows.forEach(r => statusCounts[r.status] = r.c);
    shortfalls = db.prepare(`
      SELECT te.*, c.code, c.title, co.registered_count
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND te.status = 'shortfall'
    `).all(session.id);
  }
  res.render('admin/dashboard', { title: 'Registrar dashboard', session, counts, statusCounts, shortfalls });
});

// ---------- Sessions ----------
router.get('/sessions', (req, res) => {
  const sessions = db.prepare('SELECT * FROM academic_sessions ORDER BY id DESC').all();
  const semesters = db.prepare('SELECT * FROM semesters ORDER BY calendar, number').all();
  res.render('admin/sessions', { title: 'Academic sessions', sessions, semesters });
});

// Which semester each calendar is in right now (registration, timetabling and
// the lecturer/student portals follow these).
router.post('/sessions/:id/current-semester', (req, res) => {
  const reg = Number(req.body.regular_semester), conv = Number(req.body.conversion_semester);
  attempt(req, res, '/admin/sessions', 'Current semesters updated.', () => {
    const okReg = db.prepare("SELECT 1 FROM semesters WHERE calendar = 'regular' AND number = ?").get(reg);
    const okConv = db.prepare("SELECT 1 FROM semesters WHERE calendar = 'conversion' AND number = ?").get(conv);
    if (!okReg || !okConv) { flash(req, 'error', 'Pick a valid semester for each calendar.'); return false; }
    db.prepare('UPDATE academic_sessions SET regular_semester = ?, conversion_semester = ? WHERE id = ?').run(reg, conv, req.params.id);
  });
});

router.post('/semesters/:calendar/:number/rename', (req, res) => {
  attempt(req, res, '/admin/sessions', 'Semester renamed.', () => {
    const name = (req.body.name || '').trim();
    if (!name) { flash(req, 'error', 'A semester needs a name.'); return false; }
    db.prepare('UPDATE semesters SET name = ? WHERE calendar = ? AND number = ?').run(name, req.params.calendar, req.params.number);
  });
});

router.post('/sessions', (req, res) => {
  attempt(req, res, '/admin/sessions', 'Session added.', () => {
    db.prepare('INSERT INTO academic_sessions (name) VALUES (?)').run((req.body.name || '').trim());
  });
});

router.post('/sessions/:id/edit', (req, res) => {
  attempt(req, res, '/admin/sessions', 'Session updated.', () => {
    db.prepare('UPDATE academic_sessions SET name = ? WHERE id = ?').run((req.body.name || '').trim(), req.params.id);
  });
});

router.post('/sessions/:id/delete', (req, res) => {
  attempt(req, res, '/admin/sessions', 'Session deleted.', () => {
    const hasOfferings = db.prepare('SELECT 1 FROM course_offerings WHERE session_id = ?').get(req.params.id);
    if (hasOfferings) { flash(req, 'error', 'This session already has course offerings, so it can\'t be deleted.'); return false; }
    db.prepare('DELETE FROM academic_sessions WHERE id = ?').run(req.params.id);
  });
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
           (SELECT COUNT(*) FROM departments d WHERE d.college_id = co.id) AS dept_count,
           (SELECT COUNT(*) FROM venues v WHERE v.college_id = co.id) AS venue_count
    FROM colleges co
    LEFT JOIN users u ON u.id = co.dean_id
    ORDER BY co.name
  `).all();
  const deans = db.prepare("SELECT * FROM users WHERE role='dean' ORDER BY name").all();
  res.render('admin/colleges', { title: 'Colleges', colleges, deans });
});

router.post('/colleges', (req, res) => {
  const { name, code, dean_id } = req.body;
  attempt(req, res, '/admin/colleges', 'College added.', () => {
    const result = db.prepare('INSERT INTO colleges (name, code, dean_id) VALUES (?, ?, ?)').run(name, code, dean_id || null);
    // Keep the Dean's own college_id in sync — that's what actually scopes
    // their approval queue, not the reverse pointer on the college row.
    if (dean_id) {
      db.prepare('UPDATE users SET college_id = ? WHERE id = ?').run(result.lastInsertRowid, dean_id);
    }
  });
});

router.post('/colleges/:id/edit', (req, res) => {
  const { name, code, dean_id } = req.body;
  attempt(req, res, '/admin/colleges', 'College updated.', () => {
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
  });
});

router.post('/colleges/:id/delete', (req, res) => {
  attempt(req, res, '/admin/colleges', 'College deleted.', () => {
    const inUse = db.prepare(`
      SELECT 1 WHERE EXISTS (SELECT 1 FROM departments WHERE college_id = ?)
                  OR EXISTS (SELECT 1 FROM venues WHERE college_id = ?)
    `).get(req.params.id, req.params.id);
    if (inUse) { flash(req, 'error', 'Move or delete this college\'s departments and venues first.'); return false; }
    db.prepare('DELETE FROM colleges WHERE id = ?').run(req.params.id);
  });
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
  const hods = db.prepare("SELECT * FROM users WHERE role='hod' ORDER BY name").all();
  const colleges = db.prepare('SELECT * FROM colleges ORDER BY name').all();
  res.render('admin/departments', { title: 'Departments', departments, hods, colleges });
});

router.post('/departments', (req, res) => {
  const { name, code, college_id, hod_id } = req.body;
  attempt(req, res, '/admin/departments', 'Department added.', () => {
    const r = db.prepare('INSERT INTO departments (name, code, college_id, hod_id) VALUES (?, ?, ?, ?)')
      .run(name, code, college_id || null, hod_id || null);
    if (hod_id) db.prepare('UPDATE users SET department_id = ? WHERE id = ?').run(r.lastInsertRowid, hod_id);
  });
});

router.post('/departments/:id/edit', (req, res) => {
  const { name, code, college_id, hod_id } = req.body;
  attempt(req, res, '/admin/departments', 'Department updated.', () => {
    db.prepare('UPDATE departments SET name = ?, code = ?, college_id = ?, hod_id = ? WHERE id = ?')
      .run(name, code, college_id || null, hod_id || null, req.params.id);
    // Same reasoning as college/dean above: reassigning the HOD here is meant
    // to actually hand them the department's approval queue, so keep the
    // newly-picked HOD's own department_id in sync.
    if (hod_id) {
      db.prepare('UPDATE users SET department_id = ? WHERE id = ?').run(req.params.id, hod_id);
    }
  });
});

router.post('/departments/:id/delete', (req, res) => {
  attempt(req, res, '/admin/departments', 'Department deleted.', () => {
    const inUse = db.prepare(`
      SELECT 1 WHERE EXISTS (SELECT 1 FROM courses WHERE department_id = ?)
         OR EXISTS (SELECT 1 FROM users WHERE department_id = ?)
         OR EXISTS (SELECT 1 FROM programmes WHERE department_id = ?)
    `).get(req.params.id, req.params.id, req.params.id);
    if (inUse) { flash(req, 'error', 'This department still has courses, programmes or users attached.'); return false; }
    db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
  });
});

// ---------- Programmes ----------
router.get('/programmes', (req, res) => {
  const programmes = db.prepare(`
    SELECT p.*, d.name AS dept_name, co.name AS college_name, cu.name AS coordinator_name,
           (SELECT COUNT(*) FROM course_programmes cp WHERE cp.programme_id = p.id) AS course_count
    FROM programmes p
    JOIN departments d ON d.id = p.department_id
    LEFT JOIN colleges co ON co.id = d.college_id
    LEFT JOIN users cu ON cu.id = p.coordinator_id
    ORDER BY d.name, p.name
  `).all();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const coordinators = db.prepare(`
    SELECT u.id, u.name, u.department_id, d.code AS dept_code,
           (SELECT COUNT(*) FROM programmes p WHERE p.coordinator_id = u.id) AS programme_count
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.role = 'coordinator' ORDER BY u.name
  `).all();
  res.render('admin/programmes', { title: 'Programmes', programmes, departments, coordinators });
});

// A coordinator may run programmes in any department (and any college) —
// the only requirement is that the account really has the coordinator role.
function coordinatorOk(req, coordinatorId) {
  if (!coordinatorId) return true;
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'coordinator'").get(coordinatorId)) {
    flash(req, 'error', 'Pick a Programme Coordinator account.');
    return false;
  }
  return true;
}

router.post('/programmes', (req, res) => {
  const { name, code, department_id, coordinator_id } = req.body;
  const mode = access.MODES[req.body.study_mode] ? req.body.study_mode : 'full_time';
  attempt(req, res, '/admin/programmes', 'Programme added.', () => {
    if (!coordinatorOk(req, coordinator_id)) return false;
    db.prepare('INSERT INTO programmes (name, code, department_id, coordinator_id, study_mode) VALUES (?, ?, ?, ?, ?)')
      .run(name, code, department_id, coordinator_id || null, mode);
    access.syncAllScopes(); // department-wide / all-programme courses pick the new programme up
  });
});

router.post('/programmes/:id/edit', (req, res) => {
  const { name, code, department_id, coordinator_id } = req.body;
  attempt(req, res, '/admin/programmes', 'Programme updated.', () => {
    if (!coordinatorOk(req, coordinator_id)) return false;
    db.prepare('UPDATE programmes SET name = ?, code = ?, department_id = ?, coordinator_id = ?, study_mode = ? WHERE id = ?')
      .run(name, code, department_id, coordinator_id || null, access.MODES[req.body.study_mode] ? req.body.study_mode : 'full_time', req.params.id);
    access.syncAllScopes();
  });
});

router.post('/programmes/:id/delete', (req, res) => {
  attempt(req, res, '/admin/programmes', 'Programme deleted.', () => {
    // Links that only exist because of a course's scope (all / department-wide) don't count as "in use".
    const inUse = db.prepare("SELECT 1 FROM course_programmes WHERE programme_id = ? AND source = 'manual'").get(req.params.id)
      || db.prepare('SELECT 1 FROM courses WHERE programme_id = ?').get(req.params.id);
    if (inUse) { flash(req, 'error', 'This programme still has courses — move or remove them first.'); return false; }
    db.prepare("DELETE FROM course_programmes WHERE programme_id = ? AND source = 'scope'").run(req.params.id);
    db.prepare('DELETE FROM programmes WHERE id = ?').run(req.params.id);
  });
});

// ---------- Courses ----------
router.get('/courses', (req, res) => {
  const session = activeSession();
  const deptFilter = req.query.department_id ? Number(req.query.department_id) : '';
  const courses = db.prepare(`
    SELECT c.*, d.name AS dept_name, p.name AS programme_name,
           (SELECT COUNT(*) FROM course_offerings co WHERE co.course_id = c.id) AS offering_count
    FROM courses c
    JOIN departments d ON d.id = c.department_id
    LEFT JOIN programmes p ON p.id = c.programme_id
    ${deptFilter ? 'WHERE c.department_id = ?' : ''}
    ORDER BY c.code
  `).all(...(deptFilter ? [deptFilter] : []));
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const programmes = db.prepare('SELECT * FROM programmes ORDER BY name').all();
  const allProgrammes = access.allProgrammesWithCollege();
  const linked = access.programmesByCourse(courses.map(c => c.id));
  const scopes = access.scopesByCourse(courses.map(c => c.id));
  let offerings = [];
  if (session) {
    offerings = db.prepare(`
      SELECT co.*, c.code, c.title, u.name AS lecturer_name, pu.name AS proposed_name
      FROM course_offerings co
      JOIN courses c ON c.id = co.course_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      LEFT JOIN users pu ON pu.id = co.proposed_lecturer_id
      WHERE co.session_id = ?
    `).all(session.id);
  }
  res.render('admin/courses', { title: 'Courses', courses, departments, programmes, allProgrammes, linked, scopes, session, offerings, deptFilter });
});

function courseFields(body) {
  const { code, title, credit_units, department_id, programme_id, level, expected_class_size, course_type, semester } = body;
  return [(code || '').trim(), (title || '').trim(), credit_units || 3, department_id, programme_id || null, level, expected_class_size || null,
          access.normalizeCourseType(course_type) || 'compulsory', [1, 2, 3].includes(Number(semester)) ? Number(semester) : 1];
}

router.post('/courses', (req, res) => {
  const f = courseFields(req.body);
  attempt(req, res, '/admin/courses', 'Course added.', () => {
    // The registrar has full authority — a course they add goes straight to
    // 'approved', skipping the Dean review that an HOD-proposed course needs.
    const r = db.prepare(`
      INSERT INTO courses (code, title, credit_units, department_id, programme_id, level, expected_class_size, course_type, semester, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,'approved',?)
    `).run(...f, req.session.user.id);
    access.applySharing({ id: r.lastInsertRowid, programme_id: f[4] }, req.body, req.session.user.id);
  });
});

router.post('/courses/:id/edit', (req, res) => {
  const f = courseFields(req.body);
  attempt(req, res, '/admin/courses', 'Course updated.', () => {
    db.prepare(`
      UPDATE courses SET code = ?, title = ?, credit_units = ?, department_id = ?, programme_id = ?, level = ?, expected_class_size = ?, course_type = ?, semester = ?
      WHERE id = ?
    `).run(...f, req.params.id);
    // Changing the home programme must keep it among the programmes offering the course.
    if (f[4]) access.linkCourseToProgramme(req.params.id, f[4], req.session.user.id);
  });
});

// Which programmes (across every college) offer this course.
router.post('/courses/:id/programmes', (req, res) => {
  attempt(req, res, '/admin/courses', 'Programmes updated for that course.', () => {
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    if (!course) return false;
    access.applySharing(course, req.body, req.session.user.id);
  });
});

// Delete one course, or (below) every ticked course — typically a whole
// department's. Courses with student registrations or a published timetable
// are kept and reported.
// Level and semester at which each *other* programme takes this course
// (the course's own level/semester are the home programme's). Blank = same.
router.post('/courses/:id/placements', (req, res) => {
  attempt(req, res, '/admin/courses', 'Levels and semesters updated.', () => {
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    if (!course) return false;
    db.prepare('SELECT programme_id FROM course_programmes WHERE course_id = ?').all(course.id).forEach(l => {
      if (l.programme_id === course.programme_id) return;
      if (('level_' + l.programme_id) in req.body) access.setPlacement(course.id, l.programme_id, req.body['level_' + l.programme_id], req.body['semester_' + l.programme_id]);
    });
  });
});

router.post('/courses/:id/delete', (req, res) => {
  const back = req.body.return_to && String(req.body.return_to).startsWith('/admin/courses') && !String(req.body.return_to).startsWith('//') ? req.body.return_to : '/admin/courses';
  attempt(req, res, back, null, () => {
    const r = access.deleteCourses([req.params.id]);
    flash(req, r.deleted.length ? 'success' : 'error', r.deleted.length ? 'Course deleted.' : `Course kept: ${r.blocked.map(b => b.reason).join('; ')}.`);
  });
});

router.post('/courses/bulk-delete', (req, res) => {
  const back = req.body.return_to && String(req.body.return_to).startsWith('/admin/courses') && !String(req.body.return_to).startsWith('//') ? req.body.return_to : '/admin/courses';
  attempt(req, res, back, null, () => {
    const ids = [].concat(req.body.course_ids || []);
    if (!ids.length) { flash(req, 'error', 'Tick the courses you want to delete first.'); return; }
    const r = access.deleteCourses(ids);
    flash(req, r.deleted.length ? 'success' : 'error', access.deleteSummary(r));
  });
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
  const made = access.offerCourse(course.id, session.id);
  const label = access.makeSemLabel();
  flash(req, 'success', made.length
    ? `${course.code} offered: ${made.map(m => `${access.MODES[m.study_mode]} · ${label(m.study_mode, m.semester)}`).join(', ')}.`
    : `${course.code} is already offered for every study mode and semester it runs in.`);
  res.redirect('/admin/courses');
});

// ---------- Courses: bulk upload ----------
// One course per CSV row. Columns (header row optional):
//   code, title, level, credit_units, department_code, programme_code,
//   expected_class_size, also_offered_by
// - department_code is the OWNING department; programme_code (optional) is its
//   home programme within that department.
// - also_offered_by (optional) lists further programmes that offer the same
//   course — in this or any other college — separated by "|", each written as
//   DEPT:PROG (e.g. ENG:EEE|MTH:MTH). That's how a service course shared by
//   several programmes/colleges is loaded in one row.
const CSV_COLUMNS = ['code', 'title', 'level', 'credit_units', 'department_code', 'programme_code', 'expected_class_size', 'also_offered_by', 'course_type', 'semester'];

router.get('/courses/import', (req, res) => {
  res.render('admin/course-import', { title: 'Bulk upload courses', result: null, csv: '', mode: 'skip' });
});

router.get('/courses/template.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="courses-template.csv"');
  res.send([
    CSV_COLUMNS.join(','),
    'CSC313,Operations Research,300,3,CSC,CS,60,,elective,1',
    'GST201,General Studies II,200,2,CSC,CS,300,ALL,compulsory,1',
    'CYB201,Intro to Cyber Security,300,3,CSC,CS,60,CSC:CYB@200/1,compulsory,2',
    'MTH301,Numerical Analysis,300,3,MTH,MTH,45,CSC:CS',
    '',
  ].join('\n'));
});

router.post('/courses/import', (req, res) => {
  const { csv, mode } = req.body;
  const update = mode === 'update';
  const rows = access.parseCsv(csv);
  const created = [], updated = [], skipped = [], errors = [];

  const depts = db.prepare('SELECT * FROM departments').all();
  const deptByCode = {};
  depts.forEach(d => { deptByCode[d.code.toLowerCase()] = d; });
  const progs = db.prepare('SELECT p.*, d.code AS dept_code FROM programmes p JOIN departments d ON d.id = p.department_id').all();
  const progByKey = {};          // "dept:prog" -> programme
  const progsByCode = {};        // "prog" -> [programme...]   (bare code, only usable if unambiguous)
  progs.forEach(p => {
    progByKey[`${p.dept_code}:${p.code}`.toLowerCase()] = p;
    (progsByCode[p.code.toLowerCase()] = progsByCode[p.code.toLowerCase()] || []).push(p);
  });

  function resolveProgramme(ref, ownerDept) {
    ref = ref.trim();
    if (!ref) return { none: true };
    if (ref.includes(':')) {
      const p = progByKey[ref.toLowerCase()];
      return p ? { p } : { error: `unknown programme "${ref}"` };
    }
    if (ownerDept) {
      const p = progByKey[`${ownerDept.code}:${ref}`.toLowerCase()];
      if (p) return { p };
    }
    const matches = progsByCode[ref.toLowerCase()] || [];
    if (matches.length === 1) return { p: matches[0] };
    return { error: matches.length ? `programme code "${ref}" exists in several departments — write it as DEPT:${ref}` : `unknown programme "${ref}"` };
  }

  const exists = db.prepare('SELECT * FROM courses WHERE code = ?');
  const insert = db.prepare(`
    INSERT INTO courses (code, title, credit_units, department_id, programme_id, level, expected_class_size, course_type, semester, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,'approved',?)
  `);
  const upd = db.prepare(`
    UPDATE courses SET title = ?, credit_units = ?, department_id = ?, programme_id = ?, level = ?, expected_class_size = ?, course_type = ?, semester = ?
    WHERE id = ?
  `);

  const start = rows.length && ['code', 'course code', 'course_code'].includes((rows[0][0] || '').toLowerCase()) ? 1 : 0;
  db.exec('BEGIN');
  try {
    rows.slice(start).forEach((cells, i) => {
      const line = i + start + 1;
      const [code, title, level, units, deptCode, progCode, size, also, typeCell, semCell] = cells;
      if (!code || !title || !level || !deptCode) {
        errors.push(`Row ${line}: needs at least code, title, level and department_code — got "${cells.join(',')}"`); return;
      }
      if (!Number.isInteger(Number(level)) || Number(level) <= 0) { errors.push(`Row ${line} (${code}): level "${level}" is not a number`); return; }
      const dept = deptByCode[deptCode.toLowerCase()];
      if (!dept) { errors.push(`Row ${line} (${code}): unknown department code "${deptCode}"`); return; }
      const home = resolveProgramme(progCode || '', dept);
      if (home.error) { errors.push(`Row ${line} (${code}): ${home.error}`); return; }
      if (home.p && home.p.department_id !== dept.id) { errors.push(`Row ${line} (${code}): programme "${progCode}" does not belong to ${dept.code}`); return; }
      const extra = [];
      let scope = null; const scopeDepts = []; const placements = [];
      for (let ref of (also || '').split('|').map(r => r.trim()).filter(Boolean)) {
        // Optional "@level" or "@level/semester" suffix: the level/semester THAT programme takes the course at.
        let pLevel = null, pSem = null;
        const at = ref.match(/^(.*?)@(\d+)(?:\/(\d+))?$/);
        if (at) { ref = at[1].trim(); pLevel = Number(at[2]); pSem = at[3] ? Number(at[3]) : null; }
        if (ref.toUpperCase() === 'ALL') { scope = 'all'; continue; }          // every programme in the university
        if (/^[^:]+:\*$/.test(ref)) {                                          // DEPT:* = every programme of a department
          const d = deptByCode[ref.slice(0, -2).toLowerCase()];
          if (!d) { errors.push(`Row ${line} (${code}): unknown department "${ref.slice(0, -2)}" in "${ref}"`); return; }
          scopeDepts.push(d.id); if (scope !== 'all') scope = 'departments'; continue;
        }
        const r = resolveProgramme(ref, null);
        if (r.error) { errors.push(`Row ${line} (${code}): ${r.error}`); return; }
        extra.push(r.p.id);
        if (pLevel || pSem) placements.push({ pid: r.p.id, level: pLevel, semester: pSem });
      }
      const ctype = access.normalizeCourseType(typeCell);
      if (!ctype) { errors.push(`Row ${line} (${code}): course_type "${typeCell}" must be compulsory or elective`); return; }
      const semN = semCell ? Number(semCell) : 1;
      if (![1, 2, 3].includes(semN)) { errors.push(`Row ${line} (${code}): semester "${semCell}" must be 1, 2 or 3`); return; }
      const unitsN = units ? Number(units) : 3;
      const sizeN = size ? Number(size) : null;
      const homeId = home.p ? home.p.id : null;
      const existing = exists.get(code);
      if (existing) {
        if (!update) { skipped.push(`${code} already exists`); return; }
        upd.run(title, unitsN, dept.id, homeId, Number(level), sizeN, ctype, semN, existing.id);
        access.setCourseProgrammes(existing.id, extra.concat((db.prepare("SELECT programme_id FROM course_programmes WHERE course_id = ? AND source = 'manual'").all(existing.id)).map(r => r.programme_id)), homeId, req.session.user.id);
        if (scope) access.setCourseScope(existing.id, scope, scopeDepts);
        placements.forEach(pl => access.setPlacement(existing.id, pl.pid, pl.level, pl.semester));
        updated.push(code);
      } else {
        const r = insert.run(code, title, unitsN, dept.id, homeId, Number(level), sizeN, ctype, semN, req.session.user.id);
        access.setCourseProgrammes(r.lastInsertRowid, extra, homeId, req.session.user.id);
        if (scope) access.setCourseScope(r.lastInsertRowid, scope, scopeDepts);
        placements.forEach(pl => access.setPlacement(r.lastInsertRowid, pl.pid, pl.level, pl.semester));
        created.push(code);
      }
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    errors.push(`Upload aborted, nothing was saved: ${e.message}`);
    created.length = 0; updated.length = 0;
  }
  res.render('admin/course-import', {
    title: 'Bulk upload courses', result: { created, updated, skipped, errors }, csv, mode: update ? 'update' : 'skip',
  });
});

// ---------- Venues ----------
router.get('/venues', (req, res) => {
  const collegeId = req.query.college_id || '';
  let sql = `
    SELECT v.*, co.name AS college_name, co.code AS college_code,
           (SELECT COUNT(*) FROM timetable_entries te WHERE te.venue_id = v.id) AS use_count
    FROM venues v LEFT JOIN colleges co ON co.id = v.college_id
  `;
  const params = [];
  if (collegeId === 'shared') sql += ' WHERE v.college_id IS NULL';
  else if (collegeId) { sql += ' WHERE v.college_id = ?'; params.push(collegeId); }
  sql += ' ORDER BY co.name, v.capacity DESC';
  const venues = db.prepare(sql).all(...params);
  const colleges = db.prepare('SELECT * FROM colleges ORDER BY name').all();
  res.render('admin/venues', { title: 'Venues', venues, colleges, collegeId });
});

router.post('/venues', (req, res) => {
  const { name, building, capacity, college_id } = req.body;
  attempt(req, res, '/admin/venues', 'Venue added.', () => {
    db.prepare('INSERT INTO venues (name, building, capacity, college_id) VALUES (?,?,?,?)')
      .run(name, building, capacity, college_id || null);
  });
});

router.post('/venues/:id/edit', (req, res) => {
  const { name, building, capacity, college_id } = req.body;
  attempt(req, res, '/admin/venues', 'Venue updated.', () => {
    db.prepare('UPDATE venues SET name = ?, building = ?, capacity = ?, college_id = ? WHERE id = ?')
      .run(name, building, capacity, college_id || null, req.params.id);
  });
});

router.post('/venues/:id/delete', (req, res) => {
  attempt(req, res, '/admin/venues', 'Venue deleted.', () => {
    const inUse = db.prepare('SELECT 1 FROM timetable_entries WHERE venue_id = ?').get(req.params.id);
    if (inUse) { flash(req, 'error', 'This venue is already used in a timetable entry.'); return false; }
    db.prepare('DELETE FROM venues WHERE id = ?').run(req.params.id);
  });
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
  attempt(req, res, '/admin/timeslots', 'Timeslot added.', () => {
    db.prepare('INSERT INTO timeslots (day, start_time, end_time) VALUES (?,?,?)').run(day, start_time, end_time);
  });
});

router.post('/timeslots/:id/edit', (req, res) => {
  const { day, start_time, end_time } = req.body;
  attempt(req, res, '/admin/timeslots', 'Timeslot updated.', () => {
    db.prepare('UPDATE timeslots SET day = ?, start_time = ?, end_time = ? WHERE id = ?')
      .run(day, start_time, end_time, req.params.id);
  });
});

router.post('/timeslots/:id/delete', (req, res) => {
  attempt(req, res, '/admin/timeslots', 'Timeslot deleted.', () => {
    const inUse = db.prepare('SELECT 1 FROM timetable_entries WHERE timeslot_id = ?').get(req.params.id);
    if (inUse) { flash(req, 'error', 'This timeslot is already used in a timetable entry.'); return false; }
    db.prepare('DELETE FROM timeslots WHERE id = ?').run(req.params.id);
  });
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
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING}
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
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND te.status != 'rejected' AND te.timeslot_id IS NOT NULL
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
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND te.status = 'final'
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

// ---------- Students ----------
// Admin/Registrar can add a student one at a time, bulk-create from a pasted
// CSV (name,email,department_code,level[,password]) alongside normal
// self-signup at /register/student, and correct any student's details
// (name, email, department, level, password reset) or remove the account.
// Where to land after a student action: back on the same page/filters the admin was looking at.
function studentsBack(req) {
  const r = req.body && req.body.return_to;
  return (typeof r === 'string' && r.startsWith('/admin/students') && !r.startsWith('//')) ? r : '/admin/students';
}

// Table with search, department/level filters and pagination. Rows open a
// modal for editing; everything else is a server-side page so it stays fast
// with thousands of students.
function renderStudents(req, res, result) {
  const q = (req.query.q || '').trim();
  const deptId = req.query.department_id ? Number(req.query.department_id) : '';
  const level = req.query.level ? Number(req.query.level) : '';
  const per = [10, 25, 50, 100].includes(Number(req.query.per)) ? Number(req.query.per) : 25;

  const where = ["u.role = 'student'"]; const params = [];
  if (q) { where.push('(u.name LIKE ? OR u.email LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (deptId) { where.push('u.department_id = ?'); params.push(deptId); }
  if (level) { where.push('u.level = ?'); params.push(level); }
  const W = where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) c FROM users u WHERE ${W}`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(Math.max(1, Number(req.query.page) || 1), pages);

  const students = db.prepare(`
    SELECT u.id, u.name, u.email, u.department_id, u.level, u.programme_id, u.created_at, d.name AS dept_name, d.code AS dept_code,
           pr.name AS programme_name, pr.study_mode,
           (SELECT COUNT(*) FROM enrollments e WHERE e.student_id = u.id) AS enrollment_count
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN programmes pr ON pr.id = u.programme_id
    WHERE ${W}
    ORDER BY u.name COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...params, per, (page - 1) * per);

  // Registered courses for the students on this page (shown in their modal).
  const courses = {};
  if (students.length) {
    db.prepare(`
      SELECT e.student_id, c.code, s.name AS session_name
      FROM enrollments e
      JOIN course_offerings co ON co.id = e.offering_id
      JOIN courses c ON c.id = co.course_id
      JOIN academic_sessions s ON s.id = co.session_id
      WHERE e.student_id IN (${students.map(() => '?').join(',')})
      ORDER BY s.id DESC, c.code
    `).all(...students.map(s => s.id)).forEach(r => { (courses[r.student_id] = courses[r.student_id] || []).push(`${r.code} (${r.session_name})`); });
  }
  students.forEach(s => { s.courses = courses[s.id] || []; });

  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const levels = db.prepare("SELECT DISTINCT level FROM users WHERE role = 'student' AND level IS NOT NULL ORDER BY level").all().map(r => r.level);
  res.render('admin/students', {
    title: 'Students', students, departments, levels, result: result || null,
    programmes: db.prepare('SELECT id, name, department_id, study_mode FROM programmes ORDER BY name').all(),
    filters: { q, deptId, level, per }, pager: { page, pages, total, per, from: total ? (page - 1) * per + 1 : 0, to: Math.min(page * per, total) },
  });
}

router.get('/students', (req, res) => renderStudents(req, res, null));

router.post('/students', (req, res) => {
  const { name, email, department_id, level, password, programme_id } = req.body;
  attempt(req, res, studentsBack(req), 'Student added.', () => {
    if (programme_id && !db.prepare('SELECT 1 FROM programmes WHERE id = ? AND department_id = ?').get(programme_id, department_id)) {
      flash(req, 'error', 'That programme is not in the selected department.'); return false;
    }
    const pw = password && password.length >= 8 ? password : 'password123';
    if (!(name || '').trim() || !(email || '').trim() || !department_id || !level) {
      flash(req, 'error', 'Name, email, department and level are all required.'); return false;
    }
    db.prepare("INSERT INTO users (name, email, password_hash, role, department_id, level, programme_id) VALUES (?,?,?,'student',?,?,?)")
      .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(pw, 10), department_id, Number(level), programme_id || null);
  });
});

router.post('/students/:id/edit', (req, res) => {
  const { name, email, department_id, level, new_password, programme_id } = req.body;
  attempt(req, res, studentsBack(req), 'Student details updated.', () => {
    if (programme_id && !db.prepare('SELECT 1 FROM programmes WHERE id = ? AND department_id = ?').get(programme_id, department_id)) {
      flash(req, 'error', 'That programme is not in the selected department.'); return false;
    }
    const stu = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
    if (!stu) return false;
    if (!(name || '').trim() || !(email || '').trim() || !department_id || !level) {
      flash(req, 'error', 'Name, email, department and level can\'t be left blank.'); return false;
    }
    if (new_password && new_password.length < 8) { flash(req, 'error', 'A new password must be at least 8 characters.'); return false; }
    db.prepare('UPDATE users SET name = ?, email = ?, department_id = ?, level = ?, programme_id = ? WHERE id = ?')
      .run(name.trim(), email.trim().toLowerCase(), department_id, Number(level), programme_id || null, stu.id);
    if (new_password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), stu.id);
  });
});

router.post('/students/import', (req, res) => {
  const { csv, default_password } = req.body;
  const pw = default_password && default_password.length >= 8 ? default_password : 'password123';
  const lines = (csv || '').split('\n').map(l => l.trim()).filter(Boolean);
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const deptByCode = {};
  departments.forEach(d => { deptByCode[d.code.toLowerCase()] = d; });

  const created = [];
  const errors = [];
  const insert = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, department_id, level, programme_id)
    VALUES (?, ?, ?, 'student', ?, ?, ?)
  `);
  const existsStmt = db.prepare('SELECT id FROM users WHERE email = ?');

  lines.forEach((line, i) => {
    const parts = line.split(',').map(p => p.trim());
    const [name, email, deptCode, level, progCode] = parts;
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
    let progId = null;
    if (progCode) {
      const pr = db.prepare('SELECT id FROM programmes WHERE department_id = ? AND code = ? COLLATE NOCASE').get(dept.id, progCode);
      if (!pr) { errors.push(`Line ${i + 1}: unknown programme code "${progCode}" in ${dept.code}`); return; }
      progId = pr.id;
    }
    const hash = bcrypt.hashSync(pw, 10);
    insert.run(name, email.toLowerCase(), hash, dept.id, Number(level), progId);
    created.push({ name, email });
  });

  renderStudents(req, res, { created, errors, defaultPassword: pw });
});

router.post('/students/:id/delete', (req, res) => {
  attempt(req, res, studentsBack(req), 'Student account removed.', () => {
    const hasEnrollments = db.prepare('SELECT 1 FROM enrollments WHERE student_id = ?').get(req.params.id);
    if (hasEnrollments) { flash(req, 'error', 'That student is registered for courses this session, so the account can\'t be removed.'); return false; }
    db.prepare("DELETE FROM users WHERE id = ? AND role = 'student'").run(req.params.id);
  });
});

// ---------- Staff accounts (Deans, HODs, Programme Coordinators, Lecturers) ----------
const STAFF_ROLES = ['dean', 'hod', 'coordinator', 'lecturer'];

router.get('/users', (req, res) => {
  const role = STAFF_ROLES.includes(req.query.role) ? req.query.role : '';
  let sql = `
    SELECT u.*, d.name AS dept_name, d.code AS dept_code, co.name AS college_name,
           (SELECT GROUP_CONCAT(pd.code || '/' || p.code, ', ') FROM programmes p JOIN departments pd ON pd.id = p.department_id WHERE p.coordinator_id = u.id) AS coordinates
    FROM users u
    LEFT JOIN departments d ON d.id = u.department_id
    LEFT JOIN colleges co ON co.id = u.college_id
    WHERE u.role IN ('dean','hod','coordinator','lecturer')
  `;
  const params = [];
  if (role) { sql += ' AND u.role = ?'; params.push(role); }
  sql += ' ORDER BY u.role, u.name';
  const users = db.prepare(sql).all(...params);
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const colleges = db.prepare('SELECT * FROM colleges ORDER BY name').all();
  res.render('admin/users', { title: 'Staff accounts', users, departments, colleges, role, STAFF_ROLES });
});

function staffFields(req) {
  const { name, email, role, department_id, college_id } = req.body;
  if (!(name || '').trim() || !(email || '').trim()) { flash(req, 'error', 'Name and email are required.'); return null; }
  if (!STAFF_ROLES.includes(role)) { flash(req, 'error', 'Pick a valid role.'); return null; }
  if (['hod', 'lecturer'].includes(role) && !department_id) { flash(req, 'error', `A ${role} needs a department.`); return null; }
  if (role === 'dean' && !college_id) { flash(req, 'error', 'A Dean needs a college.'); return null; }
  return {
    name: name.trim(), email: email.trim().toLowerCase(), role,
    department_id: (role === 'dean' || !department_id) ? null : Number(department_id),
    college_id: role === 'dean' ? Number(college_id) : null,
  };
}

router.post('/users', (req, res) => {
  attempt(req, res, '/admin/users', 'Account created.', () => {
    const f = staffFields(req); if (!f) return false;
    const pw = req.body.password && req.body.password.length >= 8 ? req.body.password : 'password123';
    const r = db.prepare('INSERT INTO users (name, email, password_hash, role, department_id, college_id) VALUES (?,?,?,?,?,?)')
      .run(f.name, f.email, bcrypt.hashSync(pw, 10), f.role, f.department_id, f.college_id);
    // Seat a new HOD/Dean only if the post is currently open (same rule as self-registration).
    if (f.role === 'hod') db.prepare('UPDATE departments SET hod_id = ? WHERE id = ? AND hod_id IS NULL').run(r.lastInsertRowid, f.department_id);
    if (f.role === 'dean') db.prepare('UPDATE colleges SET dean_id = ? WHERE id = ? AND dean_id IS NULL').run(r.lastInsertRowid, f.college_id);
  });
});

router.post('/users/:id/edit', (req, res) => {
  attempt(req, res, '/admin/users', 'Account updated.', () => {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('dean','hod','coordinator','lecturer')").get(req.params.id);
    if (!u) return false;
    const f = staffFields(req); if (!f) return false;
    if (req.body.new_password && req.body.new_password.length < 8) { flash(req, 'error', 'A new password must be at least 8 characters.'); return false; }
    db.prepare('UPDATE users SET name = ?, email = ?, role = ?, department_id = ?, college_id = ? WHERE id = ?')
      .run(f.name, f.email, f.role, f.department_id, f.college_id, u.id);
    if (req.body.new_password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.new_password, 10), u.id);
    // Changing someone's role/department/college takes them off any post they no longer qualify for.
    db.prepare('UPDATE colleges SET dean_id = NULL WHERE dean_id = ? AND (? != \'dean\' OR id != ?)').run(u.id, f.role, f.college_id || 0);
    db.prepare('UPDATE departments SET hod_id = NULL WHERE hod_id = ? AND (? != \'hod\' OR id != ?)').run(u.id, f.role, f.department_id || 0);
    // A coordinator keeps all their programmes, in any department; only changing role takes them off.
    if (f.role !== 'coordinator') db.prepare('UPDATE programmes SET coordinator_id = NULL WHERE coordinator_id = ?').run(u.id);
  });
});

router.post('/users/:id/delete', (req, res) => {
  attempt(req, res, '/admin/users', 'Account deleted.', () => {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('dean','hod','coordinator','lecturer')").get(req.params.id);
    if (!u) return false;
    const teaching = db.prepare('SELECT 1 FROM course_offerings WHERE lecturer_id = ? OR proposed_lecturer_id = ?').get(u.id, u.id);
    if (teaching) { flash(req, 'error', 'That person is allocated to a course offering — reassign it first.'); return false; }
    const logged = db.prepare('SELECT 1 FROM approval_log WHERE approver_id = ?').get(u.id);
    if (logged) { flash(req, 'error', 'That person has approval history that must be kept, so the account can\'t be deleted.'); return false; }
    // Leaving a post: free it. A programme whose coordinator goes simply has
    // no coordinator again, so its HOD takes over course setup and allocation.
    db.prepare('UPDATE colleges SET dean_id = NULL WHERE dean_id = ?').run(u.id);
    db.prepare('UPDATE departments SET hod_id = NULL WHERE hod_id = ?').run(u.id);
    db.prepare('UPDATE programmes SET coordinator_id = NULL WHERE coordinator_id = ?').run(u.id);
    db.prepare('UPDATE courses SET created_by = NULL WHERE created_by = ?').run(u.id);
    db.prepare('UPDATE course_offerings SET allocation_by = NULL WHERE allocation_by = ?').run(u.id);
    db.prepare('UPDATE course_programmes SET linked_by = NULL WHERE linked_by = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  });
});

module.exports = router;
