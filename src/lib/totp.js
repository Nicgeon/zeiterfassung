'use strict';

// Zwei-Faktor-Anmeldung mit Authenticator-App (TOTP, RFC 6238) und Backup-Codes (nur Serverbetrieb).
// - Neue Geheimnisse haben 160 Bit (RFC 4226 empfiehlt das). Ältere, mit otplib 12 eingerichtete Konten haben 80 Bit;
//   sie funktionieren weiter (ausdrückliche Ausnahme über die "Guardrails"), neu einrichten bringt das volle Maß.
// - Ein Code gilt ±30 Sekunden (Uhren laufen nie genau gleich) und wird nur EINMAL angenommen: verifyToken liefert
//   den Zeitschritt des Codes, der Aufrufer merkt ihn sich (users.totp_last_step) und gibt ihn beim nächsten Mal mit.

const crypto = require('crypto');
const { encryptField, decryptField } = require('./crypto');

const EPOCH_TOLERANCE = 30; // Sekunden, also ein Zeitschritt davor und danach

// otplib (und qrcode) erst laden, wenn 2FA wirklich gebraucht wird: Im lokalen Betrieb gibt es keine 2FA, ein
// Problem mit diesen Paketen darf dort den Start nicht verhindern.
let lib = null;
function otp() {
  if (!lib) {
    const otplib = require('otplib');
    // 80-Bit-Geheimnisse aus otplib 12 ausdrücklich weiter zulassen
    lib = { otplib, legacy: otplib.createGuardrails({ MIN_SECRET_BYTES: 10 }) };
  }
  return lib;
}

function generateSecret() {
  return otp().otplib.generateSecret(); // 20 Byte = 160 Bit
}

function encryptSecret(secret) {
  return encryptField(secret);
}

function decryptSecret(encSecret) {
  return decryptField(encSecret);
}

async function buildQrCodeDataUrl(secret, accountLabel, issuer) {
  const otpauth = otp().otplib.generateURI({ issuer, label: accountLabel, secret });
  return require('qrcode').toDataURL(otpauth);
}

/**
 * Prüft einen Code. Ergebnis: der Zeitschritt des Codes (Zahl) oder false.
 * afterTimeStep: zuletzt angenommener Zeitschritt – derselbe oder ein älterer Code wird abgelehnt (keine Wiederholung).
 */
function verifyToken(token, secret, { afterTimeStep = null } = {}) {
  if (!token || !secret) return false;
  const clean = String(token).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    const { otplib, legacy } = otp();
    const result = otplib.verifySync({ secret, token: clean, epochTolerance: EPOCH_TOLERANCE, guardrails: legacy });
    if (!result || !result.valid) return false;
    if (afterTimeStep !== null && afterTimeStep !== undefined && result.timeStep <= afterTimeStep) return false;
    return result.timeStep;
  } catch {
    return false;
  }
}

function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // 8 Byte Zufall (16 Hex-Zeichen, 64 Bit). Genug, damit die Codes auch
    // dann nicht durchprobiert werden koennen, wenn die Datenbank einmal
    // in falsche Haende geraet.
    codes.push(crypto.randomBytes(8).toString('hex'));
  }
  return codes;
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

module.exports = {
  generateSecret,
  encryptSecret,
  decryptSecret,
  buildQrCodeDataUrl,
  verifyToken,
  generateBackupCodes,
  hashBackupCode,
};
