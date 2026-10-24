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
  const ins = db.prepare("INSERT INTO course_programmes (course_id, programme_id, linked_by, source) VALUES (?,?,?, 'manual') ON CONFLICT(course_id, programme_id) DO UPDATE SET source = 'manual'");
  existing.forEach(pid => { if (!ids.has(pid)) del.run(courseId, pid); });
  // Upserting (rather than replacing) keeps any level/semester set for that programme.
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

/** Recompute the programme links a course's scope implies (keeping any per-programme level/semester already set). */
function syncCourseScope(courseId) {
  const c = db.prepare('SELECT id, scope FROM courses WHERE id = ?').get(courseId);
  if (!c) return;
  let want = [];
  if (c.scope === 'all') want = db.prepare('SELECT id FROM programmes').all().map(p => p.id);
  else if (c.scope === 'departments') {
    want = db.prepare('SELECT id FROM programmes WHERE department_id IN (SELECT department_id FROM course_departments WHERE course_id = ?)')
      .all(courseId).map(p => p.id);
  }
  const wanted = new Set(want);
  db.prepare("SELECT programme_id FROM course_programmes WHERE course_id = ? AND source = 'scope'").all(courseId)
    .forEach(r => { if (!wanted.has(r.programme_id)) db.prepare('DELETE FROM course_programmes WHERE course_id = ? AND programme_id = ?').run(courseId, r.programme_id); });
  const ins = db.prepare("INSERT OR IGNORE INTO course_programmes (course_id, programme_id, source) VALUES (?,?, 'scope')");
  want.forEach(pid => ins.run(courseId, pid));
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
    SELECT cp.course_id, cp.source, cp.level AS placement_level, cp.semester AS placement_semester, p.study_mode, p.id AS programme_id, p.code, p.name,
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
    SELECT p.id, p.code, p.name, p.study_mode, d.id AS dept_id, d.name AS dept_name, d.code AS dept_code,
           co.id AS college_id, co.name AS college_name, co.code AS college_code
    FROM programmes p
    JOIN departments d ON d.id = p.department_id
    LEFT JOIN colleges co ON co.id = d.college_id
    ORDER BY co.name, d.name, p.name
  `).all();
}

// ---------- Lecturer allocation ----------

// Lecturers of a department. A Programme Coordinator may also put themselves
// forward to teach one of their courses: pass their user id as `selfId` and
// they're added to the list (marked `self`). Their pick still goes to the HOD
// for approval like any other proposal.
function eligibleLecturers(departmentId, selfId) {
  const list = db.prepare("SELECT id, name, email FROM users WHERE role = 'lecturer' AND department_id = ? ORDER BY name")
    .all(departmentId);
  if (selfId) {
    const me = db.prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'coordinator'").get(selfId);
    if (me) list.unshift(Object.assign({ self: true }, me));
  }
  return list;
}

function isEligibleLecturer(lecturerId, departmentId, selfId) {
  if (selfId && Number(lecturerId) === Number(selfId)
      && db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'coordinator'").get(selfId)) return true;
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

// ---------- Study modes, semesters, level/semester per programme ----------

const MODES = { full_time: 'Full-time', part_time: 'Part-time', conversion: 'Conversion (HND → BSc)' };
const MODE_SHORT = { full_time: 'FT', part_time: 'PT', conversion: 'CV' };
// Full-time and part-time share the Harmattan/Rain calendar; conversion has its own.
const calendarOf = mode => (mode === 'conversion' ? 'conversion' : 'regular');

/** Semester name lookup, e.g. semesterName('full_time', 2) -> 'Rain'. */
function semesterNames() {
  const map = {};
  db.prepare('SELECT calendar, number, name FROM semesters ORDER BY number').all().forEach(r => { map[`${r.calendar}:${r.number}`] = r.name; });
  return map;
}
function makeSemLabel() {
  const map = semesterNames();
  return (mode, n) => map[`${calendarOf(mode)}:${n}`] || `Semester ${n}`;
}
function semestersFor(mode) {
  return db.prepare('SELECT number, name FROM semesters WHERE calendar = ? ORDER BY number').all(calendarOf(mode));
}

/**
 * SQL fragment (alias `co` = course_offerings): the offering belongs to the
 * semester its calendar is currently in. Used wherever work happens "now" —
 * student registration, the allocation engine, timetables, lecturer pages.
 * Planning views (allocation, offering lists) deliberately don't use it, so
 * both semesters of the year can be planned ahead.
 */
const CURRENT_OFFERING = `(co.semester = (SELECT CASE WHEN co.study_mode = 'conversion' THEN cs_.conversion_semester ELSE cs_.regular_semester END
                                          FROM academic_sessions cs_ WHERE cs_.id = co.session_id))`;

/**
 * Set the level / semester a (non-home) programme takes a course at.
 * Blank means "same as the course's own level / semester".
 */
function setPlacement(courseId, programmeId, level, semester) {
  const lv = level === '' || level == null ? null : Number(level);
  const sm = semester === '' || semester == null ? null : Number(semester);
  db.prepare('UPDATE course_programmes SET level = ?, semester = ? WHERE course_id = ? AND programme_id = ?')
    .run(Number.isFinite(lv) && lv > 0 ? lv : null, Number.isFinite(sm) && sm > 0 ? sm : null, courseId, programmeId);
}

/** Valid semester for a programme's calendar, falling back to the course's own. */
function effectiveSemester(link, course) {
  const valid = semestersFor(link.study_mode).map(r => r.number);
  const sm = link.semester != null ? link.semester : course.semester;
  return valid.includes(sm) ? sm : (valid.includes(course.semester) ? course.semester : valid[0]);
}

/**
 * Offer a course in a session: one offering per distinct (study mode,
 * semester) among the programmes that take it. e.g. CYB201 taken by Computer
 * Science (full-time, Rain) and Cyber Security (full-time, Harmattan) gives two
 * offerings; add a conversion programme and it gets a third.
 * Returns the offerings newly created.
 */
function offerCourse(courseId, sessionId) {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
  if (!course) return [];
  const links = db.prepare(`
    SELECT cp.semester, p.study_mode FROM course_programmes cp JOIN programmes p ON p.id = cp.programme_id WHERE cp.course_id = ?
  `).all(courseId);
  const combos = new Map();
  links.forEach(l => { const sm = effectiveSemester(l, course); combos.set(`${l.study_mode}:${sm}`, { study_mode: l.study_mode, semester: sm }); });
  if (!combos.size) combos.set(`full_time:${course.semester}`, { study_mode: 'full_time', semester: course.semester });
  const ins = db.prepare('INSERT OR IGNORE INTO course_offerings (course_id, session_id, study_mode, semester) VALUES (?,?,?,?)');
  const created = [];
  combos.forEach(c => { if (ins.run(courseId, sessionId, c.study_mode, c.semester).changes) created.push(c); });
  return created;
}

// ---------- Bulk-upload helpers (coordinator uploads) ----------

/** Lookups used to read programme references like "CSC:CS" or a bare "CS". */
function programmeResolver() {
  const depts = db.prepare('SELECT * FROM departments').all();
  const deptByCode = {}; depts.forEach(d => { deptByCode[d.code.toLowerCase()] = d; });
  const progs = db.prepare('SELECT p.*, d.code AS dept_code FROM programmes p JOIN departments d ON d.id = p.department_id').all();
  const byKey = {}, byCode = {};
  progs.forEach(p => {
    byKey[`${p.dept_code}:${p.code}`.toLowerCase()] = p;
    (byCode[p.code.toLowerCase()] = byCode[p.code.toLowerCase()] || []).push(p);
  });
  // preferDeptCode: tried first for a bare code (e.g. the uploader's own department).
  function resolve(ref, preferDeptCode) {
    ref = (ref || '').trim();
    if (!ref) return { none: true };
    if (ref.includes(':')) { const p = byKey[ref.toLowerCase()]; return p ? { p } : { error: `unknown programme "${ref}"` }; }
    if (preferDeptCode) { const p = byKey[`${preferDeptCode}:${ref}`.toLowerCase()]; if (p) return { p }; }
    const m = byCode[ref.toLowerCase()] || [];
    if (m.length === 1) return { p: m[0] };
    return { error: m.length ? `programme code "${ref}" exists in several departments — write it as DEPT:${ref}` : `unknown programme "${ref}"` };
  }
  return { deptByCode, resolve };
}

/**
 * Parse an `also_offered_by` cell: programmes separated by "|", each
 * DEPT:PROG with an optional "@level" or "@level/semester" (the level/semester
 * THAT programme takes the course at); "ALL" = every programme in the
 * university; "DEPT:*" = every programme of a department.
 */
function parseAlsoOfferedBy(text, resolver, preferDeptCode) {
  const out = { extra: [], placements: [], scope: null, scopeDepts: [], error: null };
  for (let ref of String(text || '').split('|').map(r => r.trim()).filter(Boolean)) {
    if (ref.toUpperCase() === 'ALL') { out.scope = 'all'; continue; }
    let level = null, sem = null;
    const at = ref.match(/^(.*?)@(\d+)(?:\/(\d+))?$/);
    if (at) { ref = at[1].trim(); level = Number(at[2]); sem = at[3] ? Number(at[3]) : null; }
    if (/^[^:]+:\*$/.test(ref)) {
      const d = resolver.deptByCode[ref.slice(0, -2).toLowerCase()];
      if (!d) { out.error = `unknown department "${ref.slice(0, -2)}" in "${ref}"`; return out; }
      out.scopeDepts.push(d.id); if (out.scope !== 'all') out.scope = 'departments'; continue;
    }
    const r = resolver.resolve(ref, preferDeptCode);
    if (r.error) { out.error = r.error; return out; }
    out.extra.push(r.p.id);
    if (level || sem) out.placements.push({ pid: r.p.id, level, semester: sem });
  }
  return out;
}

// ---------- Deleting courses ----------

/**
 * Delete courses (and their offerings, draft timetable slots and links).
 * A course is kept — and reported back — if students have registered for it
 * or it sits in a final/published timetable, so history is never wiped by
 * accident. Returns { deleted: [codes], blocked: [{code, reason}] }.
 */
function deleteCourses(courseIds) {
  const out = { deleted: [], blocked: [] };
  const ids = [...new Set((courseIds || []).map(Number).filter(Boolean))];
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const c = db.prepare('SELECT id, code FROM courses WHERE id = ?').get(id);
      if (!c) continue;
      const enrolled = db.prepare(`
        SELECT COUNT(*) n FROM enrollments e JOIN course_offerings co ON co.id = e.offering_id WHERE co.course_id = ?
      `).get(id).n;
      if (enrolled) { out.blocked.push({ code: c.code, reason: `${enrolled} student registration(s)` }); continue; }
      const live = db.prepare(`
        SELECT COUNT(*) n FROM timetable_entries te JOIN course_offerings co ON co.id = te.offering_id
        WHERE co.course_id = ? AND te.status IN ('final','published')
      `).get(id).n;
      if (live) { out.blocked.push({ code: c.code, reason: 'it is in a final/published timetable' }); continue; }
      const entryIds = db.prepare(`
        SELECT te.id FROM timetable_entries te JOIN course_offerings co ON co.id = te.offering_id WHERE co.course_id = ?
      `).all(id).map(r => r.id);
      entryIds.forEach(eid => db.prepare('DELETE FROM approval_log WHERE entry_id = ?').run(eid));
      db.prepare('DELETE FROM timetable_entries WHERE offering_id IN (SELECT id FROM course_offerings WHERE course_id = ?)').run(id);
      db.prepare('DELETE FROM course_offerings WHERE course_id = ?').run(id);
      db.prepare('DELETE FROM course_programmes WHERE course_id = ?').run(id);
      db.prepare('DELETE FROM course_departments WHERE course_id = ?').run(id);
      db.prepare('DELETE FROM courses WHERE id = ?').run(id);
      out.deleted.push(c.code);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return out;
}

/** One-line summary for a flash message. */
function deleteSummary(r) {
  const parts = [];
  if (r.deleted.length) parts.push(`${r.deleted.length} course(s) deleted`);
  if (r.blocked.length) parts.push(`kept: ${r.blocked.map(b => `${b.code} (${b.reason})`).join('; ')}`);
  return parts.join(' — ') || 'Nothing was deleted.';
}

const COURSE_TYPES = ['compulsory', 'elective'];
function normalizeCourseType(v) {
  const t = String(v || '').trim().toLowerCase();
  if (!t) return 'compulsory';
  if (['compulsory', 'core', 'required', 'c'].includes(t)) return 'compulsory';
  if (['elective', 'optional', 'e'].includes(t)) return 'elective';
  return null; // invalid
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
  parseCsv, deleteCourses, deleteSummary, COURSE_TYPES, normalizeCourseType,
  programmeResolver, parseAlsoOfferedBy,
  MODES, MODE_SHORT, calendarOf, semesterNames, makeSemLabel, semestersFor, CURRENT_OFFERING, setPlacement, effectiveSemester, offerCourse,
};
