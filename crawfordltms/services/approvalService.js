const { db } = require('../config/db');
const { runAllocationEngine } = require('./allocationEngine');

const NEXT_STATUS = {
  draft: 'lecturer_ok',
  lecturer_ok: 'hod_ok',
  hod_ok: 'final',
  final: 'published',
};

const ROLE_FOR_STATUS = {
  draft: 'lecturer',   // lecturer approves a draft slot
  lecturer_ok: 'hod',  // HOD approves a lecturer-accepted slot
  hod_ok: 'dean',      // Dean gives final cross-department approval
  final: 'admin',      // Registrar publishes
};

function logDecision(entryId, role, userId, decision, reason = null) {
  db.prepare(`
    INSERT INTO approval_log (entry_id, approver_role, approver_id, decision, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(entryId, role, userId, decision, reason);
}

function getEntry(entryId) {
  return db.prepare(`
    SELECT te.*, co.session_id, co.lecturer_id, co.course_id
    FROM timetable_entries te
    JOIN course_offerings co ON co.id = te.offering_id
    WHERE te.id = ?
  `).get(entryId);
}

/** Accept/advance an entry one step in the approval chain. */
function approve(entryId, role, userId) {
  const entry = getEntry(entryId);
  if (!entry) throw new Error('Timetable entry not found');
  const expectedRole = ROLE_FOR_STATUS[entry.status];
  if (expectedRole !== role) {
    throw new Error(`This entry is awaiting ${expectedRole || 'no further'} action, not ${role}.`);
  }
  const nextStatus = NEXT_STATUS[entry.status];
  db.prepare(`UPDATE timetable_entries SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(nextStatus, entryId);
  logDecision(entryId, role, userId, nextStatus === 'published' ? 'published' : 'accepted');
  return nextStatus;
}

/**
 * Reject an entry (e.g. lecturer objects to a clash). Per Fig.3: reject with
 * reason -> the allocation engine re-runs for just that course -> a new
 * draft slot is produced.
 */
function reject(entryId, role, userId, reason) {
  const entry = getEntry(entryId);
  if (!entry) throw new Error('Timetable entry not found');
  db.prepare(`
    UPDATE timetable_entries SET status = 'rejected', reject_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(reason, entryId);
  logDecision(entryId, role, userId, 'rejected', reason);

  // Re-run allocation for just this course offering -> produces a new draft.
  const results = runAllocationEngine(entry.session_id, { onlyOfferingId: entry.offering_id, useEstimates: true });
  return results[0] || null;
}

/**
 * Late add/drop re-allocation trigger (section 6 / Fig.1): only re-run the
 * allocation for an offering if the new registered_count now exceeds the
 * capacity of its currently assigned venue.
 */
function handleLateChange(offeringId) {
  const offering = db.prepare('SELECT * FROM course_offerings WHERE id = ?').get(offeringId);
  const count = db.prepare('SELECT COUNT(*) c FROM enrollments WHERE offering_id = ?').get(offeringId).c;
  db.prepare('UPDATE course_offerings SET registered_count = ? WHERE id = ?').run(count, offeringId);

  const currentEntry = db.prepare(`
    SELECT te.*, v.capacity FROM timetable_entries te
    LEFT JOIN venues v ON v.id = te.venue_id
    WHERE te.offering_id = ? AND te.status != 'rejected'
    ORDER BY te.id DESC LIMIT 1
  `).get(offeringId);

  if (!currentEntry) return { changed: false, reason: 'No existing timetable entry yet.' };

  // A provisional entry (allocated off the HOD's estimated class size, not
  // real registrations) gets promoted to a real allocation the moment the
  // course has its first actual registration — even if the estimate still
  // technically fits — so nothing stays flagged "provisional" once live
  // data exists to allocate against instead.
  const justWentLive = currentEntry.is_provisional && count > 0;

  if (!justWentLive && currentEntry.capacity && count <= currentEntry.capacity) {
    return { changed: false, reason: 'Published timetable left untouched — still within venue capacity.' };
  }

  const results = runAllocationEngine(offering.session_id, { onlyOfferingId: offeringId, useEstimates: true });
  return {
    changed: true,
    reason: justWentLive
      ? 'First real registration received — replacing the provisional estimate-based slot.'
      : 'Capacity exceeded — re-allocation triggered.',
    result: results[0] || null,
  };
}

module.exports = { approve, reject, handleLateChange, getEntry, NEXT_STATUS, ROLE_FOR_STATUS };
