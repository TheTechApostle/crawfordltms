const bcrypt = require('bcryptjs');
const { db } = require('../config/db');

/**
 * Create a new user account. `role` is a fixed value the caller passes in —
 * each /register/<role> route hardcodes its own role here rather than
 * reading it from req.body, so tampering with the submitted form can't
 * change what role gets created.
 *
 * Returns { error } on validation failure, or { user } on success.
 */
<<<<<<< HEAD
function createAccount({ role, name, email, password, confirmPassword, departmentId, collegeId, level }) {
=======
function createAccount({ role, name, email, password, confirmPassword, departmentId, facultyId, level }) {
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanName = (name || '').trim();

  if (!cleanName || !cleanEmail || !password) {
    return { error: 'Name, email and password are all required.' };
  }
  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters.' };
  }
  if (password !== confirmPassword) {
    return { error: 'Passwords do not match.' };
  }
  if ((role === 'student' || role === 'lecturer' || role === 'hod') && !departmentId) {
    return { error: 'Please select a department.' };
  }
  if (role === 'student' && !level) {
    return { error: 'Please select your level.' };
  }
<<<<<<< HEAD
  if (role === 'dean' && !collegeId) {
    return { error: 'Please select a college.' };
=======
  if (role === 'dean' && !facultyId) {
    return { error: 'Please select a faculty.' };
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) {
    return { error: 'That email is already registered — try signing in instead.' };
  }

  const hash = bcrypt.hashSync(password, 10);
  const deptId = (role === 'student' || role === 'lecturer' || role === 'hod') ? Number(departmentId) : null;
<<<<<<< HEAD
  const collId = role === 'dean' ? Number(collegeId) : null;
  const lvl = role === 'student' ? Number(level) : null;

  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, department_id, college_id, level)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(cleanName, cleanEmail, hash, role, deptId, collId, lvl);
  const newUserId = result.lastInsertRowid;

  // If the seat is currently open, seat this new HOD/Dean as the
  // department's/college's official head — otherwise leave the existing
=======
  const facId = role === 'dean' ? Number(facultyId) : null;
  const lvl = role === 'student' ? Number(level) : null;

  const result = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, department_id, faculty_id, level)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(cleanName, cleanEmail, hash, role, deptId, facId, lvl);
  const newUserId = result.lastInsertRowid;

  // If the seat is currently open, seat this new HOD/Dean as the
  // department's/faculty's official head — otherwise leave the existing
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
  // designation alone and let the registrar reassign it manually later.
  if (role === 'hod') {
    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(deptId);
    if (dept && !dept.hod_id) {
      db.prepare('UPDATE departments SET hod_id = ? WHERE id = ?').run(newUserId, deptId);
    }
  }
  if (role === 'dean') {
<<<<<<< HEAD
    const coll = db.prepare('SELECT * FROM colleges WHERE id = ?').get(collId);
    if (coll && !coll.dean_id) {
      db.prepare('UPDATE colleges SET dean_id = ? WHERE id = ?').run(newUserId, collId);
=======
    const fac = db.prepare('SELECT * FROM faculties WHERE id = ?').get(facId);
    if (fac && !fac.dean_id) {
      db.prepare('UPDATE faculties SET dean_id = ? WHERE id = ?').run(newUserId, facId);
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
    }
  }

  return {
    user: {
      id: newUserId, name: cleanName, email: cleanEmail, role,
<<<<<<< HEAD
      department_id: deptId, college_id: collId, level: lvl,
=======
      department_id: deptId, faculty_id: facId, level: lvl,
>>>>>>> 69af3544f270fdcb7c21091b20e0cad4d282d351
    },
  };
}

module.exports = { createAccount };
