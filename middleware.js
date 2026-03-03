function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

function attachUser(req, res, next) {
  if (req.session && req.session.userId) {
    req.user = { id: req.session.userId, role: req.session.role };
  }
  next();
}

module.exports = { requireAuth, requireAdmin, attachUser };
