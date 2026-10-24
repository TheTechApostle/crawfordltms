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
      SELECT c.*, cp.level AS placement_level, cp.semester AS placement_semester,
             d.name AS dept_name, d.code AS dept_code, hp.code AS home_programme_code,
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
  const ctype = access.normalizeCourseType(req.body.course_type) || 'compulsory';
  const sem = [1, 2, 3].includes(Number(req.body.semester)) ? Number(req.body.semester) : 1;
  try {
    // Owned by the programme's department, home programme = this one, and — like
    // an HOD proposal — it waits for the Dean of the college before it can be offered.
    const r = db.prepare(`
      INSERT INTO courses (code, title, credit_units, department_id, programme_id, level, expected_class_size, course_type, semester, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?)
    `).run((code || '').trim(), (title || '').trim(), credit_units || 3, programme.department_id, programme.id,
           level, expected_class_size || null, ctype, sem, req.session.user.id);
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
    // This programme may take it at a different level / semester than the owner does.
    if (req.body.level || req.body.semester) access.setPlacement(course.id, programme.id, req.body.level, req.body.semester);
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
  const ctype = access.normalizeCourseType(req.body.course_type) || 'compulsory';
  const sem = [1, 2, 3].includes(Number(req.body.semester)) ? Number(req.body.semester) : 1;
  try {
    db.prepare(`
      UPDATE courses SET code = ?, title = ?, credit_units = ?, level = ?, expected_class_size = ?, course_type = ?, semester = ?,
             status = 'pending', reject_reason = NULL
      WHERE id = ?
    `).run((code || '').trim(), (title || '').trim(), credit_units || 3, level, expected_class_size || null, ctype, sem, course.id);
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

// Level/semester THIS programme takes a shared course at (blank = same as the owner's).
router.post('/courses/:id/placement', (req, res) => {
  const programme = pickProgramme(req, myProgrammes(req));
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  const linked = programme && course && db.prepare('SELECT 1 FROM course_programmes WHERE course_id = ? AND programme_id = ?').get(course.id, programme.id);
  if (!linked || course.programme_id === programme.id) flash(req, 'error', 'You can only set the level/semester of shared courses linked to your programme.');
  else {
    access.setPlacement(course.id, programme.id, req.body.level, req.body.semester);
    flash(req, 'success', `${course.code} will be taken by ${programme.name} at the level/semester you set.`);
  }
  res.redirect(back(req, '/coordinator/courses', programme));
});

// Level/semester each OTHER programme takes a course this coordinator runs at.
router.post('/courses/:id/placements', (req, res) => {
  const programme = pickProgramme(req, myProgrammes(req));
  const course = managedCourse(req, req.params.id);
  if (!course) flash(req, 'error', 'You can only change this for courses you run.');
  else {
    db.prepare('SELECT programme_id FROM course_programmes WHERE course_id = ?').all(course.id).forEach(l => {
      if (l.programme_id !== course.programme_id && ('level_' + l.programme_id) in req.body)
        access.setPlacement(course.id, l.programme_id, req.body['level_' + l.programme_id], req.body['semester_' + l.programme_id]);
    });
    flash(req, 'success', `Levels and semesters updated for ${course.code}.`);
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
    const made = access.offerCourse(course.id, session.id);
    const label = access.makeSemLabel();
    flash(req, 'success', made.length
      ? `${course.code} offered: ${made.map(m => `${access.MODES[m.study_mode]} · ${label(m.study_mode, m.semester)}`).join(', ')} — allocate lecturers next.`
      : `${course.code} is already offered for every study mode and semester it runs in.`);
  }
  res.redirect(back(req, '/coordinator/courses', programme));
});

// ---------- Lecturer allocation (proposed here, approved by the HOD) ----------
function renderAllocation(req, res, result) {
  const programmes = myProgrammes(req);
  const programme = pickProgramme(req, programmes);
  const session = activeSession();
  let offerings = [], shared = [], lecturers = [];
  if (programme && session) {
    // Offerings (every study mode and semester) of courses whose HOME programme is this one — these are mine to allocate.
    offerings = db.prepare(`
      SELECT co.*, c.code, c.title, c.level, c.department_id, c.programme_id, d.name AS dept_name,
             lu.name AS lecturer_name, pu.name AS proposed_name
      FROM course_offerings co
      JOIN courses c ON c.id = co.course_id
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN users lu ON lu.id = co.lecturer_id
      LEFT JOIN users pu ON pu.id = co.proposed_lecturer_id
      WHERE co.session_id = ? AND c.programme_id = ?
      ORDER BY co.semester, co.study_mode, c.level, c.code
    `).all(session.id, programme.id);
    // Courses owned elsewhere that this programme takes, in its own mode/semester/level — information only.
    shared = db.prepare(`
      SELECT co.*, c.code, c.title, COALESCE(cp.level, c.level) AS level, c.department_id, c.programme_id, d.name AS dept_name,
             lu.name AS lecturer_name, pu.name AS proposed_name
      FROM course_programmes cp
      JOIN courses c ON c.id = cp.course_id
      JOIN course_offerings co ON co.course_id = c.id AND co.session_id = ?
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN users lu ON lu.id = co.lecturer_id
      LEFT JOIN users pu ON pu.id = co.proposed_lecturer_id
      WHERE cp.programme_id = ? AND (c.programme_id IS NULL OR c.programme_id != ?)
        AND co.study_mode = ? AND co.semester = COALESCE(cp.semester, c.semester)
      ORDER BY co.semester, c.code
    `).all(session.id, programme.id, programme.id, programme.study_mode);
    lecturers = access.eligibleLecturers(programme.department_id, req.session.user.id); // includes the coordinator themself
  }
  res.render('coordinator/allocation', { title: 'Lecturer allocation', programmes, programme, session, offerings, shared, lecturers, selfId: req.session.user.id, result: result || null });
}

router.get('/allocation', (req, res) => renderAllocation(req, res, null));

// (Defined before /allocation/:offeringId so 'import' isn't read as an offering id.)
// ---------- Bulk allocation upload ----------
// CSV rows: course_code,lecturer_email[,study_mode,semester]. Each becomes a
// proposal for the HOD to approve (like picking the lecturer by hand). The
// lecturer must be in the course's department, or be you. If a course has
// several offerings this session (e.g. full-time Rain and conversion), add
// the study mode (full_time / part_time / conversion) and semester.
router.get('/allocation/template.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="allocation-template.csv"');
  res.send(['course_code,lecturer_email,study_mode,semester', 'CSC301,lecturer1@crawford.edu.ng,,', `CYB201,${'me@your-email'},full_time,2`, ''].join('\n'));
});

const MODE_ALIASES = { ft: 'full_time', full_time: 'full_time', 'full-time': 'full_time', pt: 'part_time', part_time: 'part_time', 'part-time': 'part_time', cv: 'conversion', conversion: 'conversion' };

router.post('/allocation/import', (req, res) => {
  const programmes = myProgrammes(req);
  const session = activeSession();
  const rows = access.parseCsv(req.body.csv);
  const result = { proposed: [], errors: [] };
  if (!session) { result.errors.push('There is no active session.'); return renderAllocation(req, res, result); }
  const myIds = programmes.map(p => p.id);
  const start = rows.length && ['course_code', 'code', 'course'].includes((rows[0][0] || '').toLowerCase()) ? 1 : 0;
  const me = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.session.user.id);

  rows.slice(start).forEach((cells, i) => {
    const line = i + start + 1;
    const [code, email, modeCell, semCell] = cells;
    if (!code || !email) { result.errors.push(`Row ${line}: needs course_code and lecturer_email`); return; }
    const course = db.prepare('SELECT * FROM courses WHERE code = ? COLLATE NOCASE').get(code);
    if (!course || !course.programme_id || !myIds.includes(course.programme_id)) {
      result.errors.push(`Row ${line} (${code}): not a course your programme runs`); return;
    }
    let offs = db.prepare('SELECT * FROM course_offerings WHERE course_id = ? AND session_id = ?').all(course.id, session.id);
    if (!offs.length) { result.errors.push(`Row ${line} (${code}): not offered this session yet — offer it under Programme courses first`); return; }
    if (modeCell) {
      const m = MODE_ALIASES[modeCell.toLowerCase()];
      if (!m) { result.errors.push(`Row ${line} (${code}): study_mode "${modeCell}" must be full_time, part_time or conversion`); return; }
      offs = offs.filter(o => o.study_mode === m);
    }
    if (semCell) offs = offs.filter(o => o.semester === Number(semCell));
    if (!offs.length) { result.errors.push(`Row ${line} (${code}): no offering matches that study mode / semester`); return; }
    if (offs.length > 1) { result.errors.push(`Row ${line} (${code}): ${offs.length} offerings this session — add study_mode and semester to say which`); return; }
    const lect = db.prepare("SELECT id, role, department_id FROM users WHERE email = ? COLLATE NOCASE AND role IN ('lecturer','coordinator')").get(email);
    if (!lect) { result.errors.push(`Row ${line} (${code}): no lecturer with email ${email}`); return; }
    if (!access.isEligibleLecturer(lect.id, course.department_id, me.id)) {
      result.errors.push(`Row ${line} (${code}): ${email} is not a lecturer in the course's department (you can also use your own email: ${me.email})`); return;
    }
    const state = access.proposeAllocation(offs[0].id, lect.id, req.session.user.id);
    result.proposed.push(`${course.code} → ${email}${state === 'approved' ? ' (already the lecturer)' : ''}`);
  });
  renderAllocation(req, res, result);
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
  if (lecturerId && !access.isEligibleLecturer(lecturerId, o.department_id, req.session.user.id)) {
    flash(req, 'error', 'Pick a lecturer from the course\'s own department (or yourself).');
    return res.redirect(back(req, '/coordinator/allocation', programme));
  }
  const state = access.proposeAllocation(o.id, lecturerId, req.session.user.id);
  flash(req, 'success', state === 'pending'
    ? `Allocation for ${o.code} sent to the Head of Department for approval${lecturerId === req.session.user.id ? ' (you put yourself forward to teach it)' : ''}.`
    : `${o.code} allocation updated.`);
  res.redirect(back(req, '/coordinator/allocation', programme));
});

// ---------- Bulk course upload ----------
// One course per row, for the programmes you coordinate; they go to the Dean
// for approval like any course you add by hand. Existing course codes are skipped.
const COURSE_CSV_COLUMNS = ['code', 'title', 'level', 'credit_units', 'programme_code', 'expected_class_size', 'course_type', 'semester', 'also_offered_by'];

router.get('/courses/template.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="coordinator-courses-template.csv"');
  res.send([
    COURSE_CSV_COLUMNS.join(','),
    'CSC350,Compiler Construction,300,3,,60,compulsory,1,',
    'CYB201,Intro to Cyber Security,200,3,,60,compulsory,1,CSC:CS@300/2',
    'GST301,Entrepreneurship,300,2,,300,compulsory,2,ALL',
    '',
  ].join('\n'));
});

router.get('/courses/import', (req, res) => {
  res.render('coordinator/course-import', { title: 'Bulk upload courses', programmes: myProgrammes(req), result: null, csv: '', programme: pickProgramme(req, myProgrammes(req)) });
});

router.post('/courses/import', (req, res) => {
  const programmes = myProgrammes(req);
  const programme = pickProgramme(req, programmes);
  const rows = access.parseCsv(req.body.csv);
  const created = [], skipped = [], errors = [];
  if (!programme) { errors.push('You have no programme to add courses to.'); }
  else {
    const resolver = access.programmeResolver();
    const mineById = new Map(programmes.map(p => [p.id, p]));
    const exists = db.prepare('SELECT 1 FROM courses WHERE code = ? COLLATE NOCASE');
    const insert = db.prepare(`
      INSERT INTO courses (code, title, credit_units, department_id, programme_id, level, expected_class_size, course_type, semester, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?)
    `);
    const start = rows.length && ['code', 'course code', 'course_code'].includes((rows[0][0] || '').toLowerCase()) ? 1 : 0;
    db.exec('BEGIN');
    try {
      rows.slice(start).forEach((cells, i) => {
        const line = i + start + 1;
        const [code, title, level, units, progCode, size, typeCell, semCell, also] = cells;
        if (!code || !title || !level) { errors.push(`Row ${line}: needs at least code, title and level`); return; }
        if (!Number.isInteger(Number(level)) || Number(level) <= 0) { errors.push(`Row ${line} (${code}): level "${level}" is not a number`); return; }
        // Home programme: the row's programme_code if given (must be one you coordinate), else the one selected above.
        let home = programme;
        if (progCode) {
          const r = resolver.resolve(progCode, programme.dept_code);
          if (r.error) { errors.push(`Row ${line} (${code}): ${r.error}`); return; }
          home = mineById.get(r.p.id);
          if (!home) { errors.push(`Row ${line} (${code}): you don't coordinate "${progCode}"`); return; }
        }
        const ctype = access.normalizeCourseType(typeCell);
        if (!ctype) { errors.push(`Row ${line} (${code}): course_type "${typeCell}" must be compulsory or elective`); return; }
        const sem = semCell ? Number(semCell) : 1;
        if (![1, 2, 3].includes(sem)) { errors.push(`Row ${line} (${code}): semester "${semCell}" must be 1, 2 or 3`); return; }
        const sharing = access.parseAlsoOfferedBy(also, resolver, home.dept_code);
        if (sharing.error) { errors.push(`Row ${line} (${code}): ${sharing.error}`); return; }
        if (exists.get(code)) { skipped.push(`${code} already exists`); return; }
        const r = insert.run(code, title, units ? Number(units) : 3, home.department_id, home.id, Number(level), size ? Number(size) : null, ctype, sem, req.session.user.id);
        access.setCourseProgrammes(r.lastInsertRowid, sharing.extra, home.id, req.session.user.id);
        if (sharing.scope) access.setCourseScope(r.lastInsertRowid, sharing.scope, sharing.scopeDepts);
        sharing.placements.forEach(pl => access.setPlacement(r.lastInsertRowid, pl.pid, pl.level, pl.semester));
        created.push(code);
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK'); created.length = 0;
      errors.push(`Upload aborted, nothing was saved: ${e.message}`);
    }
  }
  res.render('coordinator/course-import', { title: 'Bulk upload courses', programmes, programme, result: { created, skipped, errors }, csv: req.body.csv || '' });
});

module.exports = router;
