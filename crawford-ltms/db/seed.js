require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('../config/db');

const PASSWORD = 'password123';
const hash = bcrypt.hashSync(PASSWORD, 10);

function seedAll() {
  // ---------- Admin (no faculty/department ties) ----------
  const insUser = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, department_id, faculty_id, level) VALUES (?,?,?,?,?,?,?)
  `);
  insUser.run('Mrs. Adaeze Nwosu', 'admin@crawford.edu.ng', hash, 'admin', null, null, null);

  // ---------- Faculties (dean_id set after the dean user exists) ----------
  const insFaculty = db.prepare('INSERT INTO faculties (name, code, dean_id) VALUES (?, ?, ?)');
  const facultyScience = insFaculty.run('Faculty of Science', 'SCI', null).lastInsertRowid;
  // A second faculty with no dean assigned yet, to demonstrate that a
  // department's timetable stays scoped to its own faculty.
  const facultyEng = insFaculty.run('Faculty of Engineering', 'ENG', null).lastInsertRowid;

  // ---------- Dean (tied to their faculty via users.faculty_id — the same
  // pattern used for a HOD's department, or a student's department) ----------
  const deanId = insUser.run('Prof. Emeka Okafor', 'dean@crawford.edu.ng', hash, 'dean', null, facultyScience, null).lastInsertRowid;
  db.prepare('UPDATE faculties SET dean_id = ? WHERE id = ?').run(deanId, facultyScience);

  // ---------- Departments (no HOD yet — set after HOD users exist) ----------
  const insDept = db.prepare('INSERT INTO departments (name, code, faculty_id) VALUES (?, ?, ?)');
  const deptCS = insDept.run('Computer Science', 'CSC', facultyScience).lastInsertRowid;
  const deptMTH = insDept.run('Mathematics', 'MTH', facultyScience).lastInsertRowid;
  const deptPHY = insDept.run('Physics', 'PHY', facultyScience).lastInsertRowid;
  const deptMEE = insDept.run('Mechanical Engineering', 'MEE', facultyEng).lastInsertRowid;

  // ---------- Remaining users ----------
  const hodCsId = insUser.run('Dr. Funmilayo Bello', 'hod.cs@crawford.edu.ng', hash, 'hod', deptCS, null, null).lastInsertRowid;
  const hodMthId = insUser.run('Dr. Ibrahim Suleiman', 'hod.mth@crawford.edu.ng', hash, 'hod', deptMTH, null, null).lastInsertRowid;
  const hodMeeId = insUser.run('Dr. Patience Igwe', 'hod.mee@crawford.edu.ng', hash, 'hod', deptMEE, null, null).lastInsertRowid;

  const lect1 = insUser.run('Dr. Chika Umeh', 'lecturer1@crawford.edu.ng', hash, 'lecturer', deptCS, null, null).lastInsertRowid;
  const lect2 = insUser.run('Mr. Tunde Alabi', 'lecturer2@crawford.edu.ng', hash, 'lecturer', deptCS, null, null).lastInsertRowid;
  const lect3 = insUser.run('Dr. Grace Effiong', 'lecturer3@crawford.edu.ng', hash, 'lecturer', deptMTH, null, null).lastInsertRowid;

  db.prepare('UPDATE departments SET hod_id = ? WHERE id = ?').run(hodCsId, deptCS);
  db.prepare('UPDATE departments SET hod_id = ? WHERE id = ?').run(hodMthId, deptMTH);
  db.prepare('UPDATE departments SET hod_id = ? WHERE id = ?').run(hodMeeId, deptMEE);

  const studentNames = [
    'Blessing Okonkwo', 'David Eze', 'Peace Amadi', 'Samuel Ojo', 'Ruth Danjuma',
    'Michael Adeyemi', 'Grace Uche', 'Emmanuel Bassey', 'Joy Ibekwe', 'Daniel Musa',
    'Faith Nwachukwu', 'John Etim', 'Mercy Yakubu', 'Victor Chukwu', 'Esther Obi',
    'Paul Idris', 'Precious Nnamdi', 'Isaac Balogun', 'Deborah Okoro', 'Joseph Aliyu'
  ];
  const studentIds = studentNames.map((name, i) => {
    const email = `student${i + 1}@crawford.edu.ng`;
    return insUser.run(name, email, hash, 'student', deptCS, null, 300).lastInsertRowid;
  });

  // ---------- Courses ----------
  // All pre-existing catalogue courses go straight to 'approved' (they're
  // already in active use in the seed data). One extra course is left
  // 'pending' to demonstrate the HOD-proposes / Dean-approves workflow.
  const insCourse = db.prepare(`
    INSERT INTO courses (code, title, credit_units, department_id, level, status, created_by)
    VALUES (?,?,?,?,?,'approved',?)
  `);
  const csc313 = insCourse.run('CSC313', 'Operations Research', 3, deptCS, 300, hodCsId).lastInsertRowid;
  const csc301 = insCourse.run('CSC301', 'Software Engineering', 3, deptCS, 300, hodCsId).lastInsertRowid;
  const csc305 = insCourse.run('CSC305', 'Database Systems', 3, deptCS, 300, hodCsId).lastInsertRowid;
  const mth301 = insCourse.run('MTH301', 'Numerical Analysis', 3, deptMTH, 300, hodMthId).lastInsertRowid;
  insCourse.run('PHY301', 'Thermodynamics', 3, deptPHY, 300, null);
  insCourse.run('MEE301', 'Thermofluids', 3, deptMEE, 300, hodMeeId);

  db.prepare(`
    INSERT INTO courses (code, title, credit_units, department_id, level, status, created_by)
    VALUES (?,?,?,?,?,'pending',?)
  `).run('CSC420', 'Machine Learning', 3, deptCS, 400, hodCsId);

  // ---------- Venues ----------
  const insVenue = db.prepare('INSERT INTO venues (name, building, capacity) VALUES (?,?,?)');
  const venueA = insVenue.run('Auditorium A', 'Main Block', 250).lastInsertRowid;
  const venueB = insVenue.run('Lecture Theatre 1', 'Science Block', 120).lastInsertRowid;
  const venueC = insVenue.run('Lecture Theatre 2', 'Science Block', 80).lastInsertRowid;
  const venueD = insVenue.run('Seminar Room 3', 'Engineering Block', 40).lastInsertRowid;
  insVenue.run('Tutorial Room 5', 'Engineering Block', 20);

  // ---------- Timeslots ----------
  const insSlot = db.prepare('INSERT INTO timeslots (day, start_time, end_time) VALUES (?,?,?)');
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const bands = [['08:00', '10:00'], ['10:00', '12:00'], ['13:00', '15:00'], ['15:00', '17:00']];
  days.forEach(d => bands.forEach(([s, e]) => insSlot.run(d, s, e)));

  // ---------- Academic session ----------
  const sessionId = db.prepare('INSERT INTO academic_sessions (name, is_active, reg_locked) VALUES (?,1,0)')
    .run('2025/2026 - First Semester').lastInsertRowid;

  // ---------- Course offerings (with lecturers already assigned) ----------
  // Note: MEE301 is deliberately left un-offered this session, so the
  // Faculty of Engineering starts with no timetable entries — a clean way
  // to demonstrate that a Dean only ever sees their own faculty's queue.
  const insOffering = db.prepare(`
    INSERT INTO course_offerings (course_id, lecturer_id, session_id) VALUES (?,?,?)
  `);
  const off313 = insOffering.run(csc313, lect1, sessionId).lastInsertRowid;
  const off301 = insOffering.run(csc301, lect1, sessionId).lastInsertRowid;
  const off305 = insOffering.run(csc305, lect2, sessionId).lastInsertRowid;
  const offMth = insOffering.run(mth301, lect3, sessionId).lastInsertRowid;

  // ---------- Enrollments ----------
  const insEnroll = db.prepare('INSERT INTO enrollments (offering_id, student_id) VALUES (?,?)');
  studentIds.forEach(sid => {
    insEnroll.run(off313, sid);
    insEnroll.run(off301, sid);
    if (Math.random() > 0.4) insEnroll.run(off305, sid);
    if (Math.random() > 0.6) insEnroll.run(offMth, sid);
  });

  console.log('Seed complete.');
  console.log(`Venues: ${venueA}(250) ${venueB}(120) ${venueC}(80) ${venueD}(40)`);
}

function run() {
  const already = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (already > 0) {
    console.log('Database already seeded — skipping. Delete db/crawford_ltms.sqlite to reseed.');
    return;
  }

  db.exec('BEGIN');
  try {
    seedAll();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log('\nDemo accounts (password: password123):');
  console.log('  admin@crawford.edu.ng      Registrar / Academic Affairs');
  console.log('  dean@crawford.edu.ng       Dean, Faculty of Science');
  console.log('  hod.cs@crawford.edu.ng     HOD, Computer Science (Faculty of Science)');
  console.log('  hod.mth@crawford.edu.ng    HOD, Mathematics (Faculty of Science)');
  console.log('  hod.mee@crawford.edu.ng    HOD, Mechanical Engineering (Faculty of Engineering)');
  console.log('  lecturer1@crawford.edu.ng  Lecturer, Computer Science');
  console.log('  lecturer2@crawford.edu.ng  Lecturer, Computer Science');
  console.log('  lecturer3@crawford.edu.ng  Lecturer, Mathematics');
  console.log('  student1@crawford.edu.ng .. student20@crawford.edu.ng  Students (level 300)');
  console.log('\nNew lecturers, HODs, deans and students can also self-register at /register.');
  console.log('CSC420 (Machine Learning) is seeded as a pending course proposal —');
  console.log('sign in as dean@crawford.edu.ng and open Course approvals to try it.');
}

run();
