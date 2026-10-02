'use strict';

const { db } = require('../db');

const getUserStmt = db.prepare(
  `SELECT id, username, display_name, role, active, totp_enabled, must_change_password,
          is_apprentice
   FROM users WHERE id = ?`
);

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Nicht angemeldet.' });
  }
  const user = getUserStmt.get(req.session.userId);
  if (!user || !user.active) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Sitzung ungueltig. Bitte erneut anmelden.' });
  }
  req.user = user;
  next();
}

module.exports = requireAuth;
