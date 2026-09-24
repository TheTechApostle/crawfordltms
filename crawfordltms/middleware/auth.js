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
  next();
}

module.exports = { requireLogin, requireRole, exposeUser };
