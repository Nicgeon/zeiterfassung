'use strict';

const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const crypto = require('crypto');
const { encryptField, decryptField } = require('./crypto');

authenticator.options = { window: 1 }; // allow ±1 step (±30s) clock drift

function generateSecret() {
  return authenticator.generateSecret();
}

function encryptSecret(secret) {
  return encryptField(secret);
}

function decryptSecret(encSecret) {
  return decryptField(encSecret);
}

async function buildQrCodeDataUrl(secret, accountLabel, issuer) {
  const otpauth = authenticator.keyuri(accountLabel, issuer, secret);
  return qrcode.toDataURL(otpauth);
}

function verifyToken(token, secret) {
  if (!token || !secret) return false;
  try {
    return authenticator.verify({ token: String(token).replace(/\s+/g, ''), secret });
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
