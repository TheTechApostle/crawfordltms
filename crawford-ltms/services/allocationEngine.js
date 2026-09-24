const { db } = require('../config/db');

/**
 * Best-Fit Decreasing allocation, exactly as specified in section 5 of the
 * design document:
 *   1. Pull registered_count for every course offering (from Enrollment)
 *   2. Sort offerings DESCENDING by registered_count (largest class first)
 *   3. Sort venues DESCENDING by capacity
 *   4. For each offering (largest first): find the smallest available venue
 *      where capacity >= registered_count
 *   5. If no venue is large enough -> flag a capacity shortfall
 *   6. fit_ratio = registered_count / venue.capacity
 *   7. Time slot assignment runs alongside, checking lecturer & venue
 *      availability before confirming.
 */
function runAllocationEngine(sessionId, { onlyOfferingId = null } = {}) {
  const refreshCounts = db.prepare(`
    UPDATE course_offerings
    SET registered_count = (
      SELECT COUNT(*) FROM enrollments WHERE enrollments.offering_id = course_offerings.id
    )
    WHERE session_id = ?
  `);
  refreshCounts.run(sessionId);

  let offeringsQuery = `
    SELECT co.id, co.course_id, co.lecturer_id, co.registered_count,
           c.code, c.title
    FROM course_offerings co
    JOIN courses c ON c.id = co.course_id
    WHERE co.session_id = ?
  `;
  const params = [sessionId];
  if (onlyOfferingId) {
    offeringsQuery += ' AND co.id = ?';
    params.push(onlyOfferingId);
  }
  offeringsQuery += ' ORDER BY co.registered_count DESC';
  const offerings = db.prepare(offeringsQuery).all(...params);

  const venues = db.prepare('SELECT * FROM venues ORDER BY capacity DESC').all();
  const timeslots = db.prepare('SELECT * FROM timeslots').all();

  // Track what's already taken for this session so re-allocation of a single
  // course doesn't clash with everything already published/draft.
  const takenQuery = `
    SELECT te.venue_id, te.timeslot_id, co.lecturer_id
    FROM timetable_entries te
    JOIN course_offerings co ON co.id = te.offering_id
    WHERE co.session_id = ? AND te.status != 'rejected'
      ${onlyOfferingId ? 'AND te.offering_id != ?' : ''}
  `;
  const takenParams = onlyOfferingId ? [sessionId, onlyOfferingId] : [sessionId];
  const taken = db.prepare(takenQuery).all(...takenParams);

  const venueSlotTaken = new Set(taken.map(t => `${t.venue_id}:${t.timeslot_id}`));
  const lecturerSlotTaken = new Set(taken.map(t => `${t.lecturer_id}:${t.timeslot_id}`));

  // Only clear out previous *draft*/*shortfall* attempts before re-allocating.
  // Rejected entries are kept as an audit trail (and approval_log rows point
  // at them via a foreign key, so they must not be deleted here).
  const upsertEntry = db.prepare(`
    DELETE FROM timetable_entries WHERE offering_id = ? AND status IN ('draft','shortfall')
  `);
  const insertEntry = db.prepare(`
    INSERT INTO timetable_entries (offering_id, venue_id, timeslot_id, fit_ratio, status)
    VALUES (?, ?, ?, ?, ?)
  `);

  const results = [];

  for (const offering of offerings) {
    upsertEntry.run(offering.id);

    if (offering.registered_count === 0) continue;

    // Smallest venue (already sorted DESC, so scan from the end forward is
    // "smallest that fits" -> iterate reversed) that still fully contains the class.
    const candidateVenues = [...venues].reverse().filter(v => v.capacity >= offering.registered_count);

    let assigned = null;
    for (const venue of candidateVenues) {
      for (const slot of timeslots) {
        const venueKey = `${venue.id}:${slot.id}`;
        const lecturerKey = `${offering.lecturer_id}:${slot.id}`;
        if (venueSlotTaken.has(venueKey)) continue;
        if (offering.lecturer_id && lecturerSlotTaken.has(lecturerKey)) continue;
        assigned = { venue, slot };
        break;
      }
      if (assigned) break;
    }

    if (!assigned) {
      insertEntry.run(offering.id, null, null, null, 'shortfall');
      results.push({ offering, status: 'shortfall' });
      continue;
    }

    const fitRatio = offering.registered_count / assigned.venue.capacity;
    insertEntry.run(offering.id, assigned.venue.id, assigned.slot.id, fitRatio, 'draft');
    venueSlotTaken.add(`${assigned.venue.id}:${assigned.slot.id}`);
    if (offering.lecturer_id) lecturerSlotTaken.add(`${offering.lecturer_id}:${assigned.slot.id}`);
    results.push({ offering, venue: assigned.venue, slot: assigned.slot, fitRatio, status: 'draft' });
  }

  return results;
}

/**
 * Compute which timeslots are actually schedulable for one course offering
 * right now — used by the lecturer's own "set my timetable" flow. A
 * timeslot only counts as available when:
 *   - the lecturer isn't already teaching something else in that slot, and
 *   - at least one venue big enough for the class (capacity >= registered
 *     count) is free in that slot.
 * For each available slot we return the *smallest* such venue (best fit) —
 * the lecturer never gets offered a 200-seat hall for a class of 5 when a
 * 20-seat room is sitting free at the same time.
 */
function getAvailableSlotsForOffering(offeringId) {
  const offering = db.prepare(`
    SELECT co.id, co.course_id, co.lecturer_id, co.session_id, co.registered_count
    FROM course_offerings co WHERE co.id = ?
  `).get(offeringId);
  if (!offering) return { offering: null, options: [], shortfall: false };

  // Keep the registered count fresh — a student could have registered or
  // dropped since the last time anything ran.
  const freshCount = db.prepare('SELECT COUNT(*) c FROM enrollments WHERE offering_id = ?').get(offeringId).c;
  db.prepare('UPDATE course_offerings SET registered_count = ? WHERE id = ?').run(freshCount, offeringId);
  offering.registered_count = freshCount;

  const venues = db.prepare('SELECT * FROM venues ORDER BY capacity ASC').all();
  const timeslots = db.prepare('SELECT * FROM timeslots ORDER BY day, start_time').all();

  const fittingVenues = venues.filter(v => v.capacity >= offering.registered_count);
  const shortfall = offering.registered_count > 0 && fittingVenues.length === 0;

  const taken = db.prepare(`
    SELECT te.venue_id, te.timeslot_id, co.lecturer_id
    FROM timetable_entries te
    JOIN course_offerings co ON co.id = te.offering_id
    WHERE co.session_id = ? AND te.status != 'rejected' AND te.offering_id != ?
  `).all(offering.session_id, offeringId);
  const venueSlotTaken = new Set(taken.map(t => `${t.venue_id}:${t.timeslot_id}`));
  const lecturerSlotTaken = new Set(taken.map(t => `${t.lecturer_id}:${t.timeslot_id}`));

  const options = [];
  if (offering.registered_count > 0 && !shortfall) {
    for (const slot of timeslots) {
      if (offering.lecturer_id && lecturerSlotTaken.has(`${offering.lecturer_id}:${slot.id}`)) continue;
      // fittingVenues is ascending by capacity, so the first free one here
      // is the best (smallest sufficient) fit for this slot.
      const venue = fittingVenues.find(v => !venueSlotTaken.has(`${v.id}:${slot.id}`));
      if (!venue) continue;
      options.push({ slot, venue, fitRatio: offering.registered_count / venue.capacity });
    }
  }

  return { offering, options, shortfall };
}

module.exports = { runAllocationEngine, getAvailableSlotsForOffering };
