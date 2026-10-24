const express = require('express');
const router = express.Router();
const { db } = require('../config/db');
const access = require('../services/courseAccess');
const { requireRole } = require('../middleware/auth');
const { handleLateChange } = require('../services/approvalService');

router.use(requireRole('student'));

function activeSession() {
  return db.prepare('SELECT * FROM academic_sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
}

router.get('/', (req, res) => {
  const session = activeSession();
  let registeredCount = 0, publishedCount = 0;
  if (session) {
    registeredCount = db.prepare(`
      SELECT COUNT(*) c FROM enrollments e
      JOIN course_offerings co ON co.id = e.offering_id
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND e.student_id = ?
    `).get(session.id, req.session.user.id).c;
    publishedCount = db.prepare(`
      SELECT COUNT(*) c FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN enrollments e ON e.offering_id = co.id
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND e.student_id = ? AND te.status = 'published'
    `).get(session.id, req.session.user.id).c;
  }
  res.render('student/dashboard', { title: 'Student dashboard', session, registeredCount, publishedCount });
});

router.get('/register', (req, res) => {
  const session = activeSession();
  const user = req.session.user;
  const me = db.prepare('SELECT u.level, u.programme_id, p.name AS programme_name, p.study_mode FROM users u LEFT JOIN programmes p ON p.id = u.programme_id WHERE u.id = ?').get(user.id);
  let offerings = [], myOfferingIds = new Set();
  if (session) {
    // Offerings of the CURRENT semester of the student's calendar. With a
    // programme set, a course shows only if their programme takes it at their
    // level, in that semester and study mode (levels/semesters can differ per
    // programme). Students without a programme fall back to matching on level.
    const base = `
      SELECT co.*, c.code, c.title, c.credit_units, c.course_type, d.name AS dept_name, u.name AS lecturer_name,
             COALESCE(cp.level, c.level) AS level
      FROM course_offerings co
      JOIN courses c ON c.id = co.course_id
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      %JOIN%
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND c.status = 'approved' %WHERE%
      ORDER BY c.code
    `;
    if (me.programme_id) {
      offerings = db.prepare(base
        .replace('%JOIN%', `JOIN course_programmes cp ON cp.course_id = c.id AND cp.programme_id = ?
                            JOIN programmes sp ON sp.id = cp.programme_id`)
        .replace('%WHERE%', `AND sp.study_mode = co.study_mode
                             AND COALESCE(cp.semester, c.semester) = co.semester
                             AND COALESCE(cp.level, c.level) = ?`))
        .all(me.programme_id, session.id, me.level || 0);
    } else {
      offerings = db.prepare(base.replace('%JOIN%', 'LEFT JOIN course_programmes cp ON 0').replace('%WHERE%', 'AND c.level = ?'))
        .all(session.id, me.level || 0);
    }
    const mine = db.prepare(`
      SELECT offering_id FROM enrollments e
      JOIN course_offerings co ON co.id = e.offering_id
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND e.student_id = ?
    `).all(session.id, user.id);
    myOfferingIds = new Set(mine.map(m => m.offering_id));
  }
  res.render('student/register', { title: 'Course registration', session, offerings, myOfferingIds, me });
});

router.post('/register/:offeringId', (req, res) => {
  const session = activeSession();
  if (!session) return res.redirect('/student/register');
  if (session.reg_locked) {
    return res.render('error', { title: 'Registration locked', message: 'Registration is locked for this session — see the registrar for late changes.' });
  }
  try {
    db.prepare('INSERT INTO enrollments (offering_id, student_id) VALUES (?, ?)')
      .run(req.params.offeringId, req.session.user.id);
  } catch (e) { /* already registered */ }
  res.redirect('/student/register');
});

router.post('/register/:offeringId/drop', (req, res) => {
  db.prepare('DELETE FROM enrollments WHERE offering_id = ? AND student_id = ?')
    .run(req.params.offeringId, req.session.user.id);
  // Late add/drop: only re-allocate if it now exceeds the assigned venue's capacity.
  try { handleLateChange(req.params.offeringId); } catch (e) { /* no entry yet */ }
  res.redirect('/student/register');
});

router.get('/timetable', (req, res) => {
  const session = activeSession();
  let entries = [];
  if (session) {
    entries = db.prepare(`
      SELECT te.*, c.code, c.title, d.name AS dept_name, u.name AS lecturer_name, v.name AS venue_name, v.capacity,
             ts.day, ts.start_time, ts.end_time, co.registered_count
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN users u ON u.id = co.lecturer_id
      LEFT JOIN venues v ON v.id = te.venue_id
      LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
      JOIN enrollments e ON e.offering_id = co.id
      WHERE co.session_id = ? AND ${access.CURRENT_OFFERING} AND e.student_id = ? AND te.status = 'published'
    `).all(session.id, req.session.user.id);
  }
  res.render('student/timetable', { title: 'My timetable', session, entries });
});

module.exports = router;
