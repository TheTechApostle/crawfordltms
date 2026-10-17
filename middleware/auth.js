function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        title: 'Access denied',
        message: `This page is only available to: ${roles.join(', ')}.`,
        user: req.session.user,
      });
    }
    next();
  };
}

// Make the logged-in user (or null) available to every view without
// threading it through each render() call.
function exposeUser(req, res, next) {
  res.locals.user = req.session.user || null;
  res.locals.path = req.path;
  // One-shot flash message (set via flash() below, shown once by layout.ejs).
  if (req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
  next();
}

// Queue a message to show on the next page the user lands on, e.g.
//   flash(req, 'error', 'That code is already in use.')
function flash(req, type, message) {
  req.session.flash = { type, message };
}

module.exports = { requireLogin, requireRole, exposeUser, flash };
