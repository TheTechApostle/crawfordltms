const express = require('express');
const router = express.Router();
const { db } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const { approve, reject } = require('../services/approvalService');
const { getAvailableSlotsForOffering } = require('../services/allocationEngine');

router.use(requireRole('lecturer'));

function activeSession() {
  return db.prepare('SELECT * FROM academic_sessions WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
}
// An offering is still open for the lecturer to self-schedule when there's
// no entry yet, or the existing one hasn't moved past their own say-so —
// once it's cleared HOD/Dean/publish it can't be silently swapped out here.
function schedulableEntry(offeringId) {
  return db.prepare(`
    SELECT * FROM timetable_entries WHERE offering_id = ? AND status IN ('draft','shortfall','rejected')
    ORDER BY id DESC LIMIT 1
  `).get(offeringId);
}

router.get('/', (req, res) => {
  const session = activeSession();
  let pendingCount = 0, publishedCount = 0;
  if (session) {
    pendingCount = db.prepare(`
      SELECT COUNT(*) c FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      WHERE co.session_id = ? AND co.lecturer_id = ? AND te.status = 'draft'
    `).get(session.id, req.session.user.id).c;
    publishedCount = db.prepare(`
      SELECT COUNT(*) c FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      WHERE co.session_id = ? AND co.lecturer_id = ? AND te.status = 'published'
    `).get(session.id, req.session.user.id).c;
  }
  res.render('lecturer/dashboard', { title: 'Lecturer dashboard', session, pendingCount, publishedCount });
});

router.get('/slots', (req, res) => {
  const session = activeSession();
  let entries = [];
  if (session) {
    entries = db.prepare(`
      SELECT te.*, c.code, c.title, v.name AS venue_name, v.capacity, ts.day, ts.start_time, ts.end_time, co.registered_count
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      LEFT JOIN venues v ON v.id = te.venue_id
      LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
      WHERE co.session_id = ? AND co.lecturer_id = ? AND te.status = 'draft'
    `).all(session.id, req.session.user.id);
  }
  res.render('lecturer/slots', { title: 'My draft slots', session, entries });
});

router.post('/slots/:id/accept', (req, res) => {
  try { approve(req.params.id, 'lecturer', req.session.user.id); } catch (e) { /* ignore */ }
  res.redirect('/lecturer/slots');
});

router.post('/slots/:id/reject', (req, res) => {
  try { reject(req.params.id, 'lecturer', req.session.user.id, req.body.reason || 'Clash with another engagement'); } catch (e) { /* ignore */ }
  res.redirect('/lecturer/slots');
});

router.get('/timetable', (req, res) => {
  const session = activeSession();
  let entries = [];
  if (session) {
    entries = db.prepare(`
      SELECT te.*, c.code, c.title, d.name AS dept_name, v.name AS venue_name, v.capacity,
             ts.day, ts.start_time, ts.end_time, co.registered_count
      FROM timetable_entries te
      JOIN course_offerings co ON co.id = te.offering_id
      JOIN courses c ON c.id = co.course_id
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN venues v ON v.id = te.venue_id
      LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
      WHERE co.session_id = ? AND co.lecturer_id = ? AND te.status = 'published'
    `).all(session.id, req.session.user.id);
    entries.forEach(function (e) { e.lecturer_name = req.session.user.name; });
  }
  res.render('lecturer/timetable', { title: 'My timetable', session, entries });
});

// ---------- My courses: roster + self-scheduling ----------
router.get('/courses', (req, res) => {
  const session = activeSession();
  let offerings = [];
  if (session) {
    offerings = db.prepare(`
      SELECT co.*, c.code, c.title,
             (SELECT COUNT(*) FROM enrollments e WHERE e.offering_id = co.id) AS registered_count,
             (SELECT te.status FROM timetable_entries te
              WHERE te.offering_id = co.id AND te.status != 'rejected'
              ORDER BY te.id DESC LIMIT 1) AS entry_status,
             (SELECT v.name FROM timetable_entries te
              LEFT JOIN venues v ON v.id = te.venue_id
              WHERE te.offering_id = co.id AND te.status != 'rejected'
              ORDER BY te.id DESC LIMIT 1) AS venue_name,
             (SELECT ts.day || ' ' || ts.start_time || '–' || ts.end_time FROM timetable_entries te
              LEFT JOIN timeslots ts ON ts.id = te.timeslot_id
              WHERE te.offering_id = co.id AND te.status != 'rejected'
              ORDER BY te.id DESC LIMIT 1) AS slot_label
      FROM course_offerings co
      JOIN courses c ON c.id = co.course_id
      WHERE co.session_id = ? AND co.lecturer_id = ?
      ORDER BY c.code
    `).all(session.id, req.session.user.id);
  }
  res.render('lecturer/courses', { title: 'My courses', session, offerings });
});

router.get('/courses/:offeringId/roster', (req, res) => {
  const offering = db.prepare(`
    SELECT co.*, c.code, c.title FROM course_offerings co
    JOIN courses c ON c.id = co.course_id
    WHERE co.id = ? AND co.lecturer_id = ?
  `).get(req.params.offeringId, req.session.user.id);
  if (!offering) {
    return res.status(404).render('error', { title: 'Not found', message: 'That course offering was not found.' });
  }
  const roster = db.prepare(`
    SELECT u.name, u.email, u.level FROM enrollments e
    JOIN users u ON u.id = e.student_id
    WHERE e.offering_id = ?
    ORDER BY u.name
  `).all(req.params.offeringId);
  res.render('lecturer/roster', { title: 'Roster · ' + offering.code, offering, roster });
});

router.get('/courses/:offeringId/schedule', (req, res) => {
  const offering = db.prepare(`
    SELECT co.*, c.code, c.title FROM course_offerings co
    JOIN courses c ON c.id = co.course_id
    WHERE co.id = ? AND co.lecturer_id = ?
  `).get(req.params.offeringId, req.session.user.id);
  if (!offering) {
    return res.status(404).render('error', { title: 'Not found', message: 'That course offering was not found.' });
  }
  const existing = schedulableEntry(offering.id);
  const locked = !existing && db.prepare(`
    SELECT 1 FROM timetable_entries WHERE offering_id = ? AND status NOT IN ('draft','shortfall','rejected')
  `).get(offering.id);
  if (locked) {
    return res.render('error', {
      title: 'Already scheduled',
      message: 'This course has already moved past the draft stage — it can no longer be rescheduled from here.',
    });
  }
  const { offering: freshOffering, options, shortfall } = getAvailableSlotsForOffering(offering.id);
  offering.registered_count = freshOffering.registered_count; // recomputed from live enrollments, not the possibly-stale cached count
  res.render('lecturer/schedule', { title: 'Set timetable · ' + offering.code, offering, options, shortfall });
});

router.post('/courses/:offeringId/schedule', (req, res) => {
  const offering = db.prepare(`
    SELECT co.* FROM course_offerings co WHERE co.id = ? AND co.lecturer_id = ?
  `).get(req.params.offeringId, req.session.user.id);
  if (!offering) {
    return res.status(404).render('error', { title: 'Not found', message: 'That course offering was not found.' });
  }
  const locked = !schedulableEntry(offering.id) && db.prepare(`
    SELECT 1 FROM timetable_entries WHERE offering_id = ? AND status NOT IN ('draft','shortfall','rejected')
  `).get(offering.id);
  if (locked) {
    return res.render('error', {
      title: 'Already scheduled',
      message: 'This course has already moved past the draft stage — it can no longer be rescheduled from here.',
    });
  }

  // Never trust a submitted venue — recompute the available options
  // server-side and only accept a timeslot that's genuinely on that list.
  // This is what actually enforces "no oversized venue for a small class":
  // the option list only ever contains the smallest sufficient free venue
  // per slot, so there is nothing else the lecturer could even submit.
  const { options } = getAvailableSlotsForOffering(offering.id);
  const chosen = options.find(o => String(o.slot.id) === String(req.body.timeslot_id));
  if (!chosen) {
    return res.render('error', {
      title: 'Slot no longer available',
      message: 'That timeslot is no longer available — someone else may have just taken it. Please choose another.',
    });
  }

  db.prepare(`DELETE FROM timetable_entries WHERE offering_id = ? AND status IN ('draft','shortfall','rejected')`)
    .run(offering.id);
  const result = db.prepare(`
    INSERT INTO timetable_entries (offering_id, venue_id, timeslot_id, fit_ratio, status)
    VALUES (?, ?, ?, ?, 'lecturer_ok')
  `).run(offering.id, chosen.venue.id, chosen.slot.id, chosen.fitRatio);
  db.prepare(`
    INSERT INTO approval_log (entry_id, approver_role, approver_id, decision, reason)
    VALUES (?, 'lecturer', ?, 'accepted', 'Self-scheduled by lecturer')
  `).run(result.lastInsertRowid, req.session.user.id);

  res.redirect('/lecturer/courses');
});

module.exports = router;
