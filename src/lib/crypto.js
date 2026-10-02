'use strict';

const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV length for GCM
const TAG_LENGTH = 16;

/**
 * Encrypts a UTF-8 string field for storage at rest.
 * Output layout (base64): [12 byte IV][16 byte auth tag][ciphertext]
 * A fresh random IV is used for every call, as required for GCM.
 */
function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, config.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Reverses encryptField(). Throws if the data was tampered with or the
 * wrong key is used (GCM authentication failure).
 */
function decryptField(encoded) {
  if (encoded === null || encoded === undefined) return null;
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, config.encryptionKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Constant-time string comparison for things like backup codes. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { encryptField, decryptField, safeEqual };
