'use strict';

const express = require('express');
const { db, audit } = require('../db');
const { verifyPassword, hashPassword, isPasswordStrongEnough } = require('../lib/passwords');
const totp = require('../lib/totp');
const webauthn = require('../lib/webauthn');
const { loginLimiter, secondFactorLimiter, passkeyCeremonyLimiter } = require('../middleware/rateLimiters');
const config = require('../config');

const router = express.Router();

const getUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const getPasskeysByUser = db.prepare('SELECT * FROM passkeys WHERE user_id = ?');
const getPasskeyByCredentialId = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?');
const touchPasskey = db.prepare(
  'UPDATE passkeys SET counter = ?, last_used_at = datetime(\'now\') WHERE id = ?'
);
const getUnusedBackupCodes = db.prepare(
  'SELECT * FROM backup_codes WHERE user_id = ? AND used_at IS NULL'
);
const markBackupCodeUsed = db.prepare(
  "UPDATE backup_codes SET used_at = datetime('now') WHERE id = ?"
);
const bumpFailedLogin = db.prepare(
  'UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?'
);
const resetFailedLogin = db.prepare(
  "UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?"
);
const setPasswordStmt = db.prepare(
  "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?"
);

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    isApprentice: !!user.is_apprentice,
    totpEnabled: !!user.totp_enabled,
  };
}

function isLocked(user) {
  return user.locked_until && new Date(user.locked_until + 'Z').getTime() > Date.now();
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

// --- Password login (step 1) -------------------------------------------

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
  }

  const user = getUserByUsername.get(String(username).trim().toLowerCase());
  const genericError = { error: 'Benutzername oder Passwort ist falsch.' };

  if (!user || !user.active) {
    audit(null, 'login_failed', `unknown_or_inactive:${username}`, req.ip);
    return res.status(401).json(genericError);
  }

  if (isLocked(user)) {
    audit(user.id, 'login_blocked_locked', null, req.ip);
    return res.status(423).json({
      error: 'Konto ist wegen zu vieler Fehlversuche vorübergehend gesperrt. Bitte spaeter erneut versuchen.',
    });
  }

  const valid = await verifyPassword(user.password_hash, password);
  if (!valid) {
    const attempts = (user.failed_login_count || 0) + 1;
    let lockedUntil = null;
    if (attempts >= config.loginMaxAttempts) {
      lockedUntil = new Date(Date.now() + config.loginLockMinutes * 60000).toISOString().slice(0, 19);
    }
    bumpFailedLogin.run(attempts, lockedUntil, user.id);
    audit(user.id, 'login_failed', `attempt_${attempts}`, req.ip);
    return res.status(401).json(genericError);
  }

  resetFailedLogin.run(user.id);

  // Neue Session-ID nach erfolgreicher Passwortpruefung (Schutz gegen
  // Session-Fixation): eine evtl. vorher untergeschobene/geteilte
  // Session-ID wird damit wertlos.
  await regenerateSession(req);

  const needsPasswordChange = !!user.must_change_password;
  const needsTotp = !!user.totp_enabled;

  if (needsPasswordChange || needsTotp) {
    req.session.pending = { userId: user.id, needsPasswordChange, needsTotp };
    return res.json({ status: 'pending', needsPasswordChange, needsTotp });
  }

  req.session.userId = user.id;
  delete req.session.pending;
  audit(user.id, 'login_success', 'password', req.ip);
  return res.json({ status: 'ok', user: publicUser(user) });
});

// --- Forced password change (step 2, if required) -----------------------

router.post('/login/change-password', secondFactorLimiter, async (req, res) => {
  const pending = req.session.pending;
  if (!pending || !pending.needsPasswordChange) {
    return res.status(400).json({ error: 'Kein Passwortwechsel angefordert.' });
  }
  const { newPassword } = req.body || {};
  if (!isPasswordStrongEnough(newPassword)) {
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 10 Zeichen haben.' });
  }

  const user = getUserById.get(pending.userId);
  if (!user) return res.status(400).json({ error: 'Konto nicht gefunden.' });

  const hash = await hashPassword(newPassword);
  setPasswordStmt.run(hash, user.id);
  audit(user.id, 'password_changed', 'forced_first_login', req.ip);

  pending.needsPasswordChange = false;
  if (pending.needsTotp) {
    req.session.pending = pending;
    return res.json({ status: 'pending', needsTotp: true });
  }

  req.session.userId = user.id;
  delete req.session.pending;
  audit(user.id, 'login_success', 'password+change', req.ip);
  return res.json({ status: 'ok', user: publicUser(user) });
});

// --- TOTP verification (step 2/3, if enabled) ----------------------------

router.post('/login/verify-totp', secondFactorLimiter, (req, res) => {
  const pending = req.session.pending;
  if (!pending || !pending.needsTotp || pending.needsPasswordChange) {
    return res.status(400).json({ error: 'Kein 2FA-Schritt ausstehend.' });
  }
  const { code, backupCode } = req.body || {};
  const user = getUserById.get(pending.userId);
  if (!user) return res.status(400).json({ error: 'Konto nicht gefunden.' });

  let ok = false;
  let viaBackup = false;

  if (backupCode) {
    const hash = totp.hashBackupCode(backupCode);
    const candidate = getUnusedBackupCodes.all(user.id).find((row) => row.code_hash === hash);
    if (candidate) {
      markBackupCodeUsed.run(candidate.id);
      ok = true;
      viaBackup = true;
    }
  } else if (code) {
    const secret = totp.decryptSecret(user.totp_secret_enc);
    ok = totp.verifyToken(code, secret);
  }

  if (!ok) {
    audit(user.id, 'login_failed_totp', null, req.ip);
    return res.status(401).json({ error: 'Code ungueltig.' });
  }

  req.session.userId = user.id;
  delete req.session.pending;
  audit(user.id, 'login_success', viaBackup ? 'password+backup_code' : 'password+totp', req.ip);
  return res.json({ status: 'ok', user: publicUser(user) });
});

// --- Passkey login (usernameless / discoverable credential) -------------

router.post('/passkey/login-options', passkeyCeremonyLimiter, async (req, res) => {
  const options = await webauthn.buildAuthenticationOptions({ req });
  req.session.currentChallenge = options.challenge;
  res.json(options);
});

router.post('/passkey/login-verify', passkeyCeremonyLimiter, async (req, res) => {
  const expectedChallenge = req.session.currentChallenge;
  const response = req.body;
  if (!expectedChallenge || !response || !response.id) {
    return res.status(400).json({ error: 'Ungueltige Anfrage.' });
  }

  const passkeyRow = getPasskeyByCredentialId.get(response.id);
  if (!passkeyRow) {
    audit(null, 'login_failed_passkey', 'unknown_credential', req.ip);
    return res.status(401).json({ error: 'Passkey nicht erkannt.' });
  }
  const user = getUserById.get(passkeyRow.user_id);
  if (!user || !user.active) {
    return res.status(401).json({ error: 'Konto nicht verfuegbar.' });
  }

  let verification;
  try {
    verification = await webauthn.verifyAuthentication({ req, response, expectedChallenge, passkeyRow });
  } catch (err) {
    audit(user.id, 'login_failed_passkey', String(err.message || err), req.ip);
    return res.status(401).json({ error: 'Passkey-Anmeldung fehlgeschlagen.' });
  }

  if (!verification.verified) {
    audit(user.id, 'login_failed_passkey', 'not_verified', req.ip);
    return res.status(401).json({ error: 'Passkey-Anmeldung fehlgeschlagen.' });
  }

  touchPasskey.run(verification.authenticationInfo.newCounter, passkeyRow.id);
  await regenerateSession(req);

  if (user.must_change_password) {
    req.session.pending = { userId: user.id, needsPasswordChange: true, needsTotp: false };
    return res.json({ status: 'pending', needsPasswordChange: true });
  }

  req.session.userId = user.id;
  audit(user.id, 'login_success', 'passkey', req.ip);
  return res.json({ status: 'ok', user: publicUser(user) });
});

// --- Session info / logout ----------------------------------------------

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Nicht angemeldet.' });
  const user = getUserById.get(req.session.userId);
  if (!user || !user.active) return res.status(401).json({ error: 'Nicht angemeldet.' });
  res.json({ user: publicUser(user), localMode: config.localMode });
});

router.post('/logout', (req, res) => {
  const userId = req.session.userId;
  req.session.destroy(() => {
    audit(userId || null, 'logout', null, req.ip);
    res.clearCookie('zeit.sid');
    res.json({ status: 'ok' });
  });
});

module.exports = router;
