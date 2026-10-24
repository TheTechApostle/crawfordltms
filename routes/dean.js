const express = require('express');
const router = express.Router();
const { db } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { approve, reject } = require('../services/approvalService');
const access = require('../services/courseAccess');

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
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND d.college_id = ? AND te.status = 'hod_ok'
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
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND d.college_id = ? AND te.status = 'hod_ok'
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
    WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND d.college_id = ? AND te.status != 'rejected' AND te.venue_id IS NOT NULL
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
// Allocation itself is no longer listed here all in one heap — each department
// (and programme) links through to its own view on /dean/allocation.
router.get('/departments', (req, res) => {
  const college = myCollege(req);
  const session = activeSession();
  let departments = [];

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
  }

  res.render('dean/departments', { title: 'Departments', college, session, departments });
});

// ---------- Lecturer allocation (view only) ----------
// The Dean sees who is allocated to what, one department or programme at a
// time — never everything in one list — and does not approve it: coordinators
// propose, the HOD approves. Courses offered by several programmes show up
// under every programme/department that offers them (including courses owned
// by another college), marked as shared.
router.get('/allocation', (req, res) => {
  const college = myCollege(req);
  const session = activeSession();
  if (!college) {
    return res.render('dean/allocation', { title: 'Lecturer allocation', college, session, departments: [], programmes: [], summary: [], rows: null, deptId: '', progId: '', selected: null });
  }

  const departments = db.prepare('SELECT * FROM departments WHERE college_id = ? ORDER BY name').all(college.id);
  const programmes = db.prepare(`
    SELECT p.*, d.name AS dept_name, cu.name AS coordinator_name
    FROM programmes p JOIN departments d ON d.id = p.department_id
    LEFT JOIN users cu ON cu.id = p.coordinator_id
    WHERE d.college_id = ? ORDER BY d.name, p.name
  `).all(college.id);

  // Only accept a department/programme filter that is really in this college.
  const deptId = departments.find(d => String(d.id) === String(req.query.department_id)) ? Number(req.query.department_id) : '';
  const prog = programmes.find(p => String(p.id) === String(req.query.programme_id));
  const progId = prog ? prog.id : '';
  const effectiveDept = prog ? prog.department_id : deptId;

  // Every offering this session of a course that belongs to, or is shared
  // into, this college — one pass, then sliced per department/programme below.
  let all = [];
  if (session) {
    all = db.prepare(`
      SELECT co.id, co.study_mode, co.semester, c.semester AS course_semester, co.registered_count, co.allocation_status, co.allocation_reason, co.allocation_updated_at,
             c.id AS course_id, c.code, c.title, c.level, c.course_type, c.department_id AS home_dept_id, c.programme_id AS home_programme_id,
             d.name AS home_dept_name, hc.name AS home_college_name, hc.id AS home_college_id,
             lu.name AS lecturer_name, lu.email AS lecturer_email, pu.name AS proposed_name, bu.name AS allocated_by,
             (SELECT te.status FROM timetable_entries te WHERE te.offering_id = co.id AND te.status != 'rejected'
              ORDER BY te.id DESC LIMIT 1) AS entry_status
      FROM course_offerings co
      JOIN courses c ON c.id = co.course_id
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN colleges hc ON hc.id = d.college_id
      LEFT JOIN users lu ON lu.id = co.lecturer_id
      LEFT JOIN users pu ON pu.id = co.proposed_lecturer_id
      LEFT JOIN users bu ON bu.id = co.allocation_by
      WHERE co.session_id = ?
        AND (d.college_id = ? OR EXISTS (
              SELECT 1 FROM course_programmes cp
              JOIN programmes p ON p.id = cp.programme_id
              JOIN departments pd ON pd.id = p.department_id
              WHERE cp.course_id = c.id AND pd.college_id = ?))
      ORDER BY co.semester, co.study_mode, c.level, c.code
    `).all(session.id, college.id, college.id);
    const links = access.programmesByCourse(all.map(o => o.course_id));
    const scopes = access.scopesByCourse(all.map(o => o.course_id));
    all.forEach(o => {
      o.info = scopes[o.course_id];
      // A programme "has" this offering only if it takes the course in this offering's study mode and semester.
      o.links = (links[o.course_id] || []).filter(l => l.study_mode === o.study_mode && (l.placement_semester != null ? l.placement_semester : o.course_semester) === o.semester);
      o.levelFor = {}; o.links.forEach(l => { o.levelFor[l.programme_id] = l.placement_level || o.level; });
      o.programmes = links[o.course_id] || [];
      // Which of THIS college's departments/programmes offer the course.
      o.inDepts = new Set([o.home_college_id === college.id ? o.home_dept_id : null, ...o.links.filter(l => l.college_id === college.id).map(l => l.dept_id)].filter(Boolean));
      o.inProgs = new Set(o.links.filter(l => l.college_id === college.id).map(l => l.programme_id));
      o.shared = o.programmes.length > 1 || o.home_college_id !== college.id;
    });
  }

  // Overview (no filter chosen): counts per department and programme only.
  const tally = list => ({
    total: list.length,
    approved: list.filter(o => o.allocation_status === 'approved').length,
    pending: list.filter(o => o.allocation_status === 'pending').length,
    rejected: list.filter(o => o.allocation_status === 'rejected').length,
    none: list.filter(o => o.allocation_status === 'none').length,
  });
  const summary = departments.map(d => ({
    dept: d,
    ...tally(all.filter(o => o.inDepts.has(d.id))),
    programmes: programmes.filter(p => p.department_id === d.id).map(p => ({ prog: p, ...tally(all.filter(o => o.inProgs.has(p.id))) })),
  }));

  let rows = null, selected = null;
  if (progId) {
    rows = all.filter(o => o.inProgs.has(progId));
    rows.forEach(o => { o.level = o.levelFor[progId] || o.level; });
    selected = { type: 'programme', name: prog.name, dept_name: prog.dept_name, coordinator_name: prog.coordinator_name };
  } else if (deptId) {
    rows = all.filter(o => o.inDepts.has(deptId));
    selected = { type: 'department', name: departments.find(d => d.id === deptId).name };
  }

  res.render('dean/allocation', { title: 'Lecturer allocation', college, session, departments, programmes, summary, rows, deptId: effectiveDept, progId, selected });
});

// ---------- College-wide timetable ----------
// Filterable by department or programme so a Dean isn't stuck with one giant
// grid. Courses shared in from other programmes/colleges are included.
router.get('/timetable', (req, res) => {
  const college = myCollege(req);
  const session = activeSession();
  const bands = db.prepare('SELECT DISTINCT start_time, end_time FROM timeslots ORDER BY start_time').all();
  let entries = [], departments = [], programmes = [];
  let deptId = '', progId = '';
  if (college) {
    departments = db.prepare('SELECT * FROM departments WHERE college_id = ? ORDER BY name').all(college.id);
    programmes = db.prepare(`
      SELECT p.* FROM programmes p JOIN departments d ON d.id = p.department_id
      WHERE d.college_id = ? ORDER BY p.name
    `).all(college.id);
    const prog = programmes.find(p => String(p.id) === String(req.query.programme_id));
    if (prog) progId = prog.id;
    else if (departments.find(d => String(d.id) === String(req.query.department_id))) deptId = Number(req.query.department_id);
  }
  if (college && session) {
    let sql = `
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
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND te.status != 'rejected' AND te.timeslot_id IS NOT NULL
    `;
    const params = [session.id];
    if (progId) {
      sql += ' AND EXISTS (SELECT 1 FROM course_programmes cp WHERE cp.course_id = c.id AND cp.programme_id = ?)';
      params.push(progId);
    } else if (deptId) {
      sql += ` AND (c.department_id = ? OR EXISTS (
                 SELECT 1 FROM course_programmes cp JOIN programmes p ON p.id = cp.programme_id
                 WHERE cp.course_id = c.id AND p.department_id = ?))`;
      params.push(deptId, deptId);
    } else {
      sql += ` AND (d.college_id = ? OR EXISTS (
                 SELECT 1 FROM course_programmes cp JOIN programmes p ON p.id = cp.programme_id
                 JOIN departments pd ON pd.id = p.department_id
                 WHERE cp.course_id = c.id AND pd.college_id = ?))`;
      params.push(college.id, college.id);
    }
    entries = db.prepare(sql).all(...params);
  }
  res.render('dean/timetable', { title: 'College timetable', college, session, entries, bands, departments, programmes, deptId, progId });
});

module.exports = router;
