'use strict';

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Nur fuer Administratoren.' });
  }
  next();
}

module.exports = requireAdmin;
