'use strict';

const express = require('express');
const { db, audit, destroyUserSessions } = require('../db');
const { hashPassword, generateTempPassword } = require('../lib/passwords');

const router = express.Router();

const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

const listUsersStmt = db.prepare(`
  SELECT u.id, u.username, u.display_name, u.role, u.active, u.totp_enabled,
         u.must_change_password, u.is_apprentice, u.created_at,
         (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count
  FROM users u ORDER BY u.created_at ASC
`);
const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUserStmt = db.prepare(
  `INSERT INTO users (username, display_name, password_hash, role, must_change_password)
   VALUES (@username, @display_name, @password_hash, @role, 1)`
);
const setActiveStmt = db.prepare('UPDATE users SET active = ? WHERE id = ?');
const setRoleStmt = db.prepare("UPDATE users SET role = ? WHERE id = ?");
const setApprenticeStmt = db.prepare('UPDATE users SET is_apprentice = ? WHERE id = ?');
const resetPasswordStmt = db.prepare(
  'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?'
);
const clearTotpStmt = db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0 WHERE id = ?');
const deleteBackupCodesStmt = db.prepare('DELETE FROM backup_codes WHERE user_id = ?');
const deletePasskeysStmt = db.prepare('DELETE FROM passkeys WHERE user_id = ?');
const auditLogStmt = db.prepare(
  `SELECT a.id, a.event, a.detail, a.ip, a.created_at, u.username
   FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
   ORDER BY a.id DESC LIMIT ?`
);

function serializeUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isApprentice: !!row.is_apprentice,
    active: !!row.active,
    totpEnabled: !!row.totp_enabled,
    mustChangePassword: !!row.must_change_password,
    passkeyCount: row.passkey_count,
    createdAt: row.created_at,
  };
}

router.get('/users', (req, res) => {
  res.json({ users: listUsersStmt.all().map(serializeUser) });
});

router.post('/users', (req, res) => {
  const { username, displayName, role } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  const dname = String(displayName || '').trim();
  const r = role === 'admin' ? 'admin' : 'user';

  if (!USERNAME_RE.test(uname)) {
    return res.status(400).json({
      error: 'Benutzername: 3-40 Zeichen, nur Kleinbuchstaben, Ziffern, Punkt, Bindestrich, Unterstrich.',
    });
  }
  if (!dname) return res.status(400).json({ error: 'Anzeigename ist erforderlich.' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (existing) return res.status(409).json({ error: 'Benutzername bereits vergeben.' });

  const tempPassword = generateTempPassword();
  hashPassword(tempPassword).then((hash) => {
    const info = insertUserStmt.run({
      username: uname,
      display_name: dname,
      password_hash: hash,
      role: r,
    });
    audit(req.user.id, 'user_created', uname, req.ip);
    res.status(201).json({
      user: serializeUser(getUserStmt.get(info.lastInsertRowid)),
      tempPassword,
    });
  }).catch((err) => {
    res.status(500).json({ error: 'Fehler beim Anlegen: ' + err.message });
  });
});

router.patch('/users/:id', (req, res) => {
  const target = getUserStmt.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'active')) {
    if (target.id === req.user.id && !req.body.active) {
      return res.status(400).json({ error: 'Eigenes Konto kann nicht deaktiviert werden.' });
    }
    setActiveStmt.run(req.body.active ? 1 : 0, target.id);
    if (!req.body.active) destroyUserSessions(target.id);
    audit(req.user.id, req.body.active ? 'user_activated' : 'user_deactivated', target.username, req.ip);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'role')) {
    if (target.id === req.user.id) {
      return res.status(400).json({ error: 'Eigene Rolle kann nicht selbst geaendert werden.' });
    }
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    setRoleStmt.run(role, target.id);
    audit(req.user.id, 'user_role_changed', `${target.username}:${role}`, req.ip);
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'isApprentice')) {
    const value = req.body.isApprentice ? 1 : 0;
    setApprenticeStmt.run(value, target.id);
    audit(
      req.user.id,
      value ? 'user_apprentice_enabled' : 'user_apprentice_disabled',
      target.username,
      req.ip
    );
  }

  res.json({ user: serializeUser(getUserStmt.get(target.id)) });
});

router.post('/users/:id/reset-password', (req, res) => {
  const target = getUserStmt.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
  const tempPassword = generateTempPassword();
  hashPassword(tempPassword).then((hash) => {
    resetPasswordStmt.run(hash, target.id);
    destroyUserSessions(target.id);
    audit(req.user.id, 'password_reset_by_admin', target.username, req.ip);
    res.json({ status: 'ok', tempPassword });
  });
});

router.post('/users/:id/reset-2fa', (req, res) => {
  const target = getUserStmt.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Benutzer nicht gefunden.' });
  clearTotpStmt.run(target.id);
  deleteBackupCodesStmt.run(target.id);
  deletePasskeysStmt.run(target.id);
  destroyUserSessions(target.id);
  audit(req.user.id, 'user_2fa_reset_by_admin', target.username, req.ip);
  res.json({ status: 'ok' });
});

router.get('/audit-log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json({ entries: auditLogStmt.all(limit) });
});

module.exports = router;
