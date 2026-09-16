require('dotenv').config();
const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const bcrypt = require('bcryptjs');

const { db } = require('./config/db');
const { exposeUser } = require('./middleware/auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(session({
  secret: process.env.SESSION_SECRET || 'crawford-ltms-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 },
}));

app.use(exposeUser);

// ---------- Auth ----------
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { title: 'Sign in', layout: false });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) {
    return res.render('auth/login', { title: 'Sign in', layout: false, error: 'Incorrect email or password.' });
  }
  req.session.user = {
    id: u.id, name: u.name, email: u.email, role: u.role,
    department_id: u.department_id, faculty_id: u.faculty_id, level: u.level,
  };
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- Self-registration ----------
// The Registrar/admin account is deliberately not self-registerable — that
// seat is provisioned by whoever sets up the institution, same as the seed
// data does today. Everyone else registers on their own dedicated page —
// /register/student, /register/lecturer, /register/hod, /register/dean —
// each of which hardcodes its role below. There is no shared form, no
// combined "which role are you" page, and no role dropdown: the sign-in
// page links to each of the four directly, side by side but each its own
// separate link to its own separate page, and which page you land on is
// what account you get — no submitted field can override that.
const { createAccount } = require('./services/registration');
const ROLE_LABELS = { student: 'Student', lecturer: 'Lecturer', hod: 'Head of Department', dean: 'Dean' };

app.get('/register', (req, res) => {
  res.redirect('/login');
});

['student', 'lecturer', 'hod', 'dean'].forEach((role) => {
  app.get(`/register/${role}`, (req, res) => {
    if (req.session.user) return res.redirect('/');
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const faculties = db.prepare('SELECT * FROM faculties ORDER BY name').all();
    res.render(`auth/register-${role}`, {
      title: `Register as ${ROLE_LABELS[role]}`, layout: false, departments, faculties, form: {},
    });
  });

  app.post(`/register/${role}`, (req, res) => {
    const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
    const faculties = db.prepare('SELECT * FROM faculties ORDER BY name').all();
    const { name, email, password, confirm_password, department_id, faculty_id, level } = req.body;

    const result = createAccount({
      role, // hardcoded per-route — never taken from req.body
      name, email, password, confirmPassword: confirm_password,
      departmentId: department_id, facultyId: faculty_id, level,
    });

    if (result.error) {
      return res.render(`auth/register-${role}`, {
        title: `Register as ${ROLE_LABELS[role]}`, layout: false, departments, faculties,
        error: result.error, form: req.body,
      });
    }

    req.session.user = result.user;
    res.redirect('/');
  });
});

// ---------- Role landing / redirect ----------
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const role = req.session.user.role;
  res.redirect(`/${role}`);
});

// ---------- Routers ----------
app.use('/admin', require('./routes/admin'));
app.use('/hod', require('./routes/hod'));
app.use('/dean', require('./routes/dean'));
app.use('/lecturer', require('./routes/lecturer'));
app.use('/student', require('./routes/student'));

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not found',
    message: `That page does not exist: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Server error', message: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Crawford University LTMS running at http://localhost:${PORT}`);
});
