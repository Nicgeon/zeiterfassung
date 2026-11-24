'use strict';

const crypto = require('crypto');
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
const setTotpLastStep = db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?');
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

// Gleich lange Antwortzeit für unbekannte Namen: ohne Konto wird trotzdem ein Passwort-Hash geprüft, sonst ließe sich
// an der Antwortzeit ablesen, welche Benutzernamen es gibt.
let dummyHashPromise = null;
const dummyHash = () => (dummyHashPromise ||= hashPassword(crypto.randomBytes(16).toString('hex')));

/** Fehlversuch zählen und ab der eingestellten Zahl das Konto vorübergehend sperren (Passwort und 2FA gemeinsam). */
function countFailure(user) {
  const attempts = (user.failed_login_count || 0) + 1;
  const lockedUntil = attempts >= config.loginMaxAttempts
    ? new Date(Date.now() + config.loginLockMinutes * 60000).toISOString().slice(0, 19)
    : null;
  bumpFailedLogin.run(attempts, lockedUntil, user.id);
  return attempts;
}

const MAX_SECOND_FACTOR_TRIES = 5; // danach muss das Passwort neu eingegeben werden

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
  }

  const user = getUserByUsername.get(String(username).trim().toLowerCase());
  const genericError = { error: 'Benutzername oder Passwort ist falsch.' };

  if (!user || !user.active) {
    await verifyPassword(await dummyHash(), String(password));
    audit(null, 'login_failed', `unknown_or_inactive:${String(username).slice(0, 64)}`, req.ip);
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
    const attempts = countFailure(user);
    audit(user.id, 'login_failed', `attempt_${attempts}`, req.ip);
    return res.status(401).json(genericError);
  }

  // Mit 2FA zählen Fehlversuche weiter, bis auch der Code stimmt (sonst setzte jedes richtige Passwort den Zähler
  // zurück und Codes ließen sich in Runden zu fünf beliebig oft durchprobieren)
  if (!user.totp_enabled) resetFailedLogin.run(user.id);

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
    // jeder Code nur einmal: ein mitgelesener Code lässt sich nicht noch einmal verwenden
    const step = totp.verifyToken(code, secret, { afterTimeStep: user.totp_last_step });
    if (step !== false) {
      setTotpLastStep.run(step, user.id);
      ok = true;
    }
  }

  if (!ok) {
    // Fehlversuche zählen fürs Konto (Sperre wie beim Passwort); nach einigen falschen Codes zurück zum Passwort
    countFailure(user);
    pending.tries = (pending.tries || 0) + 1;
    audit(user.id, 'login_failed_totp', `attempt_${pending.tries}`, req.ip);
    if (pending.tries >= MAX_SECOND_FACTOR_TRIES) {
      delete req.session.pending;
      return res.status(401).json({ error: 'Zu viele falsche Codes. Bitte neu anmelden.', restart: true });
    }
    return res.status(401).json({ error: 'Code ungueltig.' });
  }
  resetFailedLogin.run(user.id);

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
