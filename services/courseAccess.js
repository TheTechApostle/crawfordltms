const { db } = require('../config/db');

/**
 * Shared rules for the Programme Coordinator / HOD / Dean split of course
 * setup and lecturer allocation, plus courses that are offered by more than
 * one programme (and so more than one college).
 *
 * WHO MANAGES A COURSE
 *   A course has an owning department (courses.department_id) and, optionally,
 *   a home programme (courses.programme_id). If the home programme has a
 *   Programme Coordinator, the coordinator adds/edits that course and proposes
 *   its lecturer allocation, and the HOD approves the allocation. If the home
 *   programme has no coordinator (or the course has no programme), the HOD does
 *   it all directly — "in the absence of a programme coordinator, the HOD can".
 *   The Dean only ever views allocations.
 *
 * LECTURER ALLOCATION STATES (course_offerings.allocation_status)
 *   none      nobody allocated yet
 *   pending   a coordinator proposed proposed_lecturer_id, awaiting the HOD
 *   approved  lecturer_id is set and signed off (HOD allocations land here
 *             directly; so do approved coordinator proposals)
 *   rejected  the HOD rejected the last proposal (reason in allocation_reason);
 *             lecturer_id still holds whatever was approved before, if any
 *   lecturer_id is only ever written on approval, so the timetable, lecturer
 *   portal and allocation engine keep reading it exactly as before.
 */

function activeSession() {
  return db.prepare('SELECT * FROM academic_sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
}

// ---------- Coordinators & programmes ----------

function programmesCoordinatedBy(userId) {
  return db.prepare(`
    SELECT p.*, d.name AS dept_name, d.code AS dept_code, d.college_id
    FROM programmes p JOIN departments d ON d.id = p.department_id
    WHERE p.coordinator_id = ? ORDER BY d.name, p.name
  `).all(userId);
}

// Who runs a course day to day: 'coordinator' if its home programme has a
// (still existing) coordinator, otherwise 'hod'.
function managerRole(course) {
  if (!course || !course.programme_id) return 'hod';
  const row = db.prepare(`
    SELECT 1 FROM programmes p JOIN users u ON u.id = p.coordinator_id
    WHERE p.id = ? AND u.role = 'coordinator'
  `).get(course.programme_id);
  return row ? 'coordinator' : 'hod';
}

// ---------- Courses offered by several programmes ----------

/**
 * Replace the programmes a course is explicitly offered under ('manual'
 * links). The home programme, if any, is always included. Links derived from
 * the course's scope (all programmes / whole departments) are managed by
 * syncCourseScope and left alone here.
 */
function setCourseProgrammes(courseId, programmeIds, homeProgrammeId, userId) {
  const ids = new Set((programmeIds || []).map(Number).filter(Boolean));
  if (homeProgrammeId) ids.add(Number(homeProgrammeId));
  const existing = new Set(db.prepare("SELECT programme_id FROM course_programmes WHERE course_id = ? AND source = 'manual'")
    .all(courseId).map(r => r.programme_id));
  const del = db.prepare("DELETE FROM course_programmes WHERE course_id = ? AND programme_id = ? AND source = 'manual'");
  const ins = db.prepare("INSERT OR REPLACE INTO course_programmes (course_id, programme_id, linked_by, source) VALUES (?,?,?, 'manual')");
  existing.forEach(pid => { if (!ids.has(pid)) del.run(courseId, pid); });
  ids.forEach(pid => { if (!existing.has(pid)) ins.run(courseId, pid, userId || null); });
  syncCourseScope(courseId);
}

function linkCourseToProgramme(courseId, programmeId, userId) {
  db.prepare("INSERT OR IGNORE INTO course_programmes (course_id, programme_id, linked_by, source) VALUES (?,?,?, 'manual')")
    .run(courseId, programmeId, userId || null);
}

/**
 * Who a course is offered to as a whole: 'programmes' (just the listed ones),
 * 'departments' (every programme of the given departments) or 'all'
 * (every programme in the university, e.g. GST courses).
 */
function setCourseScope(courseId, scope, departmentIds) {
  if (!['programmes', 'departments', 'all'].includes(scope)) scope = 'programmes';
  const depts = scope === 'departments' ? [...new Set((departmentIds || []).map(Number).filter(Boolean))] : [];
  if (scope === 'departments' && !depts.length) scope = 'programmes';
  db.prepare('UPDATE courses SET scope = ? WHERE id = ?').run(scope, courseId);
  db.prepare('DELETE FROM course_departments WHERE course_id = ?').run(courseId);
  const ins = db.prepare('INSERT OR IGNORE INTO course_departments (course_id, department_id) VALUES (?,?)');
  depts.forEach(d => ins.run(courseId, d));
  syncCourseScope(courseId);
}

/** Recompute the programme links a course's scope implies. */
function syncCourseScope(courseId) {
  const c = db.prepare('SELECT id, scope FROM courses WHERE id = ?').get(courseId);
  if (!c) return;
  db.prepare("DELETE FROM course_programmes WHERE course_id = ? AND source = 'scope'").run(courseId);
  let sql = null, params = [];
  if (c.scope === 'all') sql = 'SELECT id FROM programmes';
  else if (c.scope === 'departments') {
    sql = 'SELECT id FROM programmes WHERE department_id IN (SELECT department_id FROM course_departments WHERE course_id = ?)';
    params = [courseId];
  }
  if (!sql) return;
  const ins = db.prepare("INSERT OR IGNORE INTO course_programmes (course_id, programme_id, source) VALUES (?,?, 'scope')");
  db.prepare(sql).all(...params).forEach(p => ins.run(courseId, p.id));
}

/** Call after programmes are added/removed so department-wide and all-programme courses follow. */
function syncAllScopes() {
  db.prepare("SELECT id FROM courses WHERE scope != 'programmes'").all().forEach(c => syncCourseScope(c.id));
}

/**
 * Apply the sharing form used everywhere (add-course forms and the "Offered
 * by" picker): body.scope, body.department_ids[], body.programme_ids[].
 */
function applySharing(course, body, userId) {
  setCourseScope(course.id, body.scope, [].concat(body.department_ids || []));
  setCourseProgrammes(course.id, [].concat(body.programme_ids || []), course.programme_id, userId);
}

/** { courseId: {scope, depts:[{id,code,name}]} } for display. */
function scopesByCourse(courseIds) {
  const map = {};
  if (!courseIds.length) return map;
  const q = courseIds.map(() => '?').join(',');
  db.prepare(`SELECT id, scope FROM courses WHERE id IN (${q})`).all(...courseIds).forEach(r => { map[r.id] = { scope: r.scope, depts: [] }; });
  db.prepare(`
    SELECT cd.course_id, d.id, d.code, d.name FROM course_departments cd JOIN departments d ON d.id = cd.department_id
    WHERE cd.course_id IN (${q}) ORDER BY d.name
  `).all(...courseIds).forEach(r => { map[r.course_id].depts.push({ id: r.id, code: r.code, name: r.name }); });
  return map;
}

/**
 * For a list of course ids: { courseId: [{programme_id, code, name, dept_id,
 * dept_code, dept_name, college_id, college_code, college_name}] } — every
 * programme (and therefore department and college) the course is offered by.
 */
function programmesByCourse(courseIds) {
  const map = {};
  if (!courseIds.length) return map;
  const rows = db.prepare(`
    SELECT cp.course_id, cp.source, p.id AS programme_id, p.code, p.name,
           d.id AS dept_id, d.code AS dept_code, d.name AS dept_name,
           co.id AS college_id, co.code AS college_code, co.name AS college_name
    FROM course_programmes cp
    JOIN programmes p ON p.id = cp.programme_id
    JOIN departments d ON d.id = p.department_id
    LEFT JOIN colleges co ON co.id = d.college_id
    WHERE cp.course_id IN (${courseIds.map(() => '?').join(',')})
    ORDER BY co.name, d.name, p.name
  `).all(...courseIds);
  rows.forEach(r => { (map[r.course_id] = map[r.course_id] || []).push(r); });
  return map;
}

// Every programme in the university, with its department/college — for the
// "offered by" picker, grouped by college in the view.
function allProgrammesWithCollege() {
  return db.prepare(`
    SELECT p.id, p.code, p.name, d.id AS dept_id, d.name AS dept_name, d.code AS dept_code,
           co.id AS college_id, co.name AS college_name, co.code AS college_code
    FROM programmes p
    JOIN departments d ON d.id = p.department_id
    LEFT JOIN colleges co ON co.id = d.college_id
    ORDER BY co.name, d.name, p.name
  `).all();
}

// ---------- Lecturer allocation ----------

function eligibleLecturers(departmentId) {
  return db.prepare("SELECT id, name, email FROM users WHERE role = 'lecturer' AND department_id = ? ORDER BY name")
    .all(departmentId);
}

function isEligibleLecturer(lecturerId, departmentId) {
  return !!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'lecturer' AND department_id = ?")
    .get(lecturerId, departmentId);
}

function getOffering(offeringId) {
  return db.prepare(`
    SELECT co.*, c.department_id, c.programme_id, c.code, c.title
    FROM course_offerings co JOIN courses c ON c.id = co.course_id
    WHERE co.id = ?
  `).get(offeringId);
}

/** HOD (or registrar) allocation: takes effect immediately. */
function allocateDirect(offeringId, lecturerId, userId) {
  db.prepare(`
    UPDATE course_offerings
    SET lecturer_id = ?, proposed_lecturer_id = NULL,
        allocation_status = ?, allocation_by = ?, allocation_reason = NULL,
        allocation_updated_at = datetime('now')
    WHERE id = ?
  `).run(lecturerId || null, lecturerId ? 'approved' : 'none', userId, offeringId);
}

/** Coordinator proposal: waits for the HOD. */
function proposeAllocation(offeringId, lecturerId, userId) {
  const o = getOffering(offeringId);
  if (lecturerId && o.lecturer_id === lecturerId) {
    // Same as the approved lecturer — nothing to approve.
    db.prepare(`
      UPDATE course_offerings
      SET proposed_lecturer_id = NULL, allocation_status = 'approved', allocation_reason = NULL,
          allocation_updated_at = datetime('now')
      WHERE id = ?
    `).run(offeringId);
    return 'approved';
  }
  if (!lecturerId) {
    // Withdraw a pending/rejected proposal; the approved lecturer (if any) is untouched.
    db.prepare(`
      UPDATE course_offerings
      SET proposed_lecturer_id = NULL, allocation_status = ?, allocation_reason = NULL,
          allocation_updated_at = datetime('now')
      WHERE id = ?
    `).run(o.lecturer_id ? 'approved' : 'none', offeringId);
    return o.lecturer_id ? 'approved' : 'none';
  }
  db.prepare(`
    UPDATE course_offerings
    SET proposed_lecturer_id = ?, allocation_status = 'pending', allocation_by = ?, allocation_reason = NULL,
        allocation_updated_at = datetime('now')
    WHERE id = ?
  `).run(lecturerId, userId, offeringId);
  return 'pending';
}

function approveAllocation(offeringId, userId) {
  const o = getOffering(offeringId);
  if (!o || o.allocation_status !== 'pending' || !o.proposed_lecturer_id) return false;
  db.prepare(`
    UPDATE course_offerings
    SET lecturer_id = proposed_lecturer_id, proposed_lecturer_id = NULL,
        allocation_status = 'approved', allocation_reason = NULL,
        allocation_updated_at = datetime('now')
    WHERE id = ?
  `).run(offeringId);
  return true;
}

function rejectAllocation(offeringId, userId, reason) {
  const o = getOffering(offeringId);
  if (!o || o.allocation_status !== 'pending') return false;
  db.prepare(`
    UPDATE course_offerings
    SET proposed_lecturer_id = NULL, allocation_status = 'rejected', allocation_reason = ?,
        allocation_updated_at = datetime('now')
    WHERE id = ?
  `).run(reason || 'Rejected by HOD', offeringId);
  return true;
}

// ---------- CSV (used by the admin bulk course upload) ----------

/** Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes, CRLF/LF. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows.map(r => r.map(c => c.trim()));
}

module.exports = {
  activeSession, programmesCoordinatedBy, managerRole,
  setCourseProgrammes, linkCourseToProgramme, programmesByCourse, allProgrammesWithCollege,
  setCourseScope, syncCourseScope, syncAllScopes, applySharing, scopesByCourse,
  eligibleLecturers, isEligibleLecturer, getOffering,
  allocateDirect, proposeAllocation, approveAllocation, rejectAllocation,
  parseCsv,
};
