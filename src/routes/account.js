'use strict';

const express = require('express');
const config = require('../config');
const { db, audit, destroyUserSessions } = require('../db');
const { verifyPassword, hashPassword, isPasswordStrongEnough } = require('../lib/passwords');
const totp = require('../lib/totp');
const webauthn = require('../lib/webauthn');
const { secondFactorLimiter, passkeyCeremonyLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// Einstellungen des lokalen Nutzers (im Serverbetrieb legt der Admin das fest).
router.patch('/settings', (req, res) => {
  if (!config.localMode) return res.status(403).json({ error: 'Nur im lokalen Modus verfuegbar.' });
  const { isApprentice } = req.body || {};
  if (typeof isApprentice !== 'boolean') return res.status(400).json({ error: 'Ungueltige Eingabe.' });
  db.prepare('UPDATE users SET is_apprentice = ? WHERE id = ?').run(isApprentice ? 1 : 0, req.user.id);
  res.json({ status: 'ok', isApprentice });
});

const getUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const setPasswordStmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const setTotpStmt = db.prepare(
  'UPDATE users SET totp_secret_enc = ?, totp_enabled = 1 WHERE id = ?'
);
const disableTotpStmt = db.prepare(
  'UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0 WHERE id = ?'
);
const deleteBackupCodesStmt = db.prepare('DELETE FROM backup_codes WHERE user_id = ?');
const insertBackupCodeStmt = db.prepare(
  'INSERT INTO backup_codes (user_id, code_hash) VALUES (?, ?)'
);
const countUnusedBackupCodesStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL'
);

const listPasskeysStmt = db.prepare(
  `SELECT id, name, device_type, backed_up, created_at, last_used_at, credential_id, rp_id
   FROM passkeys WHERE user_id = ? ORDER BY created_at DESC`
);
const getPasskeysRawStmt = db.prepare('SELECT * FROM passkeys WHERE user_id = ?');
const insertPasskeyStmt = db.prepare(
  `INSERT INTO passkeys (user_id, credential_id, public_key, counter, device_type, backed_up, transports, name, rp_id)
   VALUES (@user_id, @credential_id, @public_key, @counter, @device_type, @backed_up, @transports, @name, @rp_id)`
);
const deletePasskeyStmt = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?');

// --- Password ---------------------------------------------------------

router.post('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = getUserById.get(req.user.id);
  const valid = await verifyPassword(user.password_hash, currentPassword || '');
  if (!valid) return res.status(401).json({ error: 'Aktuelles Passwort ist falsch.' });
  if (!isPasswordStrongEnough(newPassword)) {
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 10 Zeichen haben.' });
  }
  const hash = await hashPassword(newPassword);
  setPasswordStmt.run(hash, user.id);

  // Nach einem Passwortwechsel sollen alte Sitzungen (z.B. auf einem
  // verlorenen Geraet) nicht weiterlaufen. Die aktuelle Sitzung wird
  // anschliessend neu aufgebaut, damit man angemeldet bleibt.
  destroyUserSessions(user.id);
  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
  req.session.userId = user.id;

  audit(user.id, 'password_changed', 'self_service', req.ip);
  res.json({ status: 'ok', otherSessionsEnded: true });
});

// --- TOTP (2FA) ---------------------------------------------------------

router.post('/totp/setup', async (req, res) => {
  const secret = totp.generateSecret();
  req.session.pendingTotpSecret = secret;
  const qrDataUrl = await totp.buildQrCodeDataUrl(secret, req.user.username, 'Zeiterfassung');
  res.json({ secret, qrDataUrl });
});

router.post('/totp/confirm', secondFactorLimiter, (req, res) => {
  const secret = req.session.pendingTotpSecret;
  if (!secret) return res.status(400).json({ error: 'Kein 2FA-Setup gestartet.' });
  const { code } = req.body || {};
  if (!totp.verifyToken(code, secret)) {
    return res.status(400).json({ error: 'Code ungueltig. Bitte erneut versuchen.' });
  }
  setTotpStmt.run(totp.encryptSecret(secret), req.user.id);
  delete req.session.pendingTotpSecret;

  deleteBackupCodesStmt.run(req.user.id);
  const codes = totp.generateBackupCodes();
  const insertMany = db.transaction((cs) => {
    for (const c of cs) insertBackupCodeStmt.run(req.user.id, totp.hashBackupCode(c));
  });
  insertMany(codes);

  audit(req.user.id, 'totp_enabled', null, req.ip);
  res.json({ status: 'ok', backupCodes: codes });
});

router.post('/totp/disable', async (req, res) => {
  const { currentPassword } = req.body || {};
  const user = getUserById.get(req.user.id);
  const valid = await verifyPassword(user.password_hash, currentPassword || '');
  if (!valid) return res.status(401).json({ error: 'Passwort ist falsch.' });
  disableTotpStmt.run(req.user.id);
  deleteBackupCodesStmt.run(req.user.id);
  audit(req.user.id, 'totp_disabled', 'self_service', req.ip);
  res.json({ status: 'ok' });
});

router.get('/totp/backup-codes/status', (req, res) => {
  const row = countUnusedBackupCodesStmt.get(req.user.id);
  res.json({ remaining: row.n });
});

router.post('/totp/backup-codes/regenerate', secondFactorLimiter, async (req, res) => {
  const { currentPassword } = req.body || {};
  const user = getUserById.get(req.user.id);
  const valid = await verifyPassword(user.password_hash, currentPassword || '');
  if (!valid) return res.status(401).json({ error: 'Passwort ist falsch.' });
  if (!user.totp_enabled) return res.status(400).json({ error: '2FA ist nicht aktiv.' });

  deleteBackupCodesStmt.run(req.user.id);
  const codes = totp.generateBackupCodes();
  const insertMany = db.transaction((cs) => {
    for (const c of cs) insertBackupCodeStmt.run(req.user.id, totp.hashBackupCode(c));
  });
  insertMany(codes);
  audit(req.user.id, 'backup_codes_regenerated', null, req.ip);
  res.json({ status: 'ok', backupCodes: codes });
});

// --- Passkeys -------------------------------------------------------------

router.get('/passkeys', (req, res) => {
  res.json({ passkeys: listPasskeysStmt.all(req.user.id) });
});

router.post('/passkeys/register-options', passkeyCeremonyLimiter, async (req, res) => {
  const existing = getPasskeysRawStmt.all(req.user.id);
  const options = await webauthn.buildRegistrationOptions({
    req,
    userId: req.user.id,
    username: req.user.username,
    displayName: req.user.display_name,
    existingCredentials: existing,
  });
  req.session.currentChallenge = options.challenge;
  res.json(options);
});

router.post('/passkeys/register-verify', passkeyCeremonyLimiter, async (req, res) => {
  const expectedChallenge = req.session.currentChallenge;
  if (!expectedChallenge) return res.status(400).json({ error: 'Kein Registrierungsvorgang aktiv.' });

  const { response, name } = req.body || {};
  let verification;
  try {
    verification = await webauthn.verifyRegistration({ req, response, expectedChallenge });
  } catch (err) {
    return res.status(400).json({ error: 'Passkey-Registrierung fehlgeschlagen: ' + (err.message || err) });
  }
  delete req.session.currentChallenge;

  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ error: 'Passkey konnte nicht verifiziert werden.' });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  insertPasskeyStmt.run({
    user_id: req.user.id,
    credential_id: credential.id,
    public_key: Buffer.from(credential.publicKey).toString('base64'),
    counter: credential.counter,
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp ? 1 : 0,
    transports: credential.transports ? JSON.stringify(credential.transports) : null,
    name: (name && String(name).trim().slice(0, 60)) || 'Passkey',
    rp_id: webauthn.rpFor(req).rpID,
  });

  audit(req.user.id, 'passkey_registered', name || null, req.ip);
  res.status(201).json({ status: 'ok' });
});

router.delete('/passkeys/:id', (req, res) => {
  const info = deletePasskeyStmt.run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Passkey nicht gefunden.' });
  audit(req.user.id, 'passkey_deleted', req.params.id, req.ip);
  res.json({ status: 'ok' });
});

module.exports = router;
