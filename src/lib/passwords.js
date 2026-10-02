'use strict';

const argon2 = require('argon2');
const crypto = require('crypto');

const HASH_OPTIONS = { type: argon2.argon2id };

async function hashPassword(plaintext) {
  return argon2.hash(plaintext, HASH_OPTIONS);
}

async function verifyPassword(hash, plaintext) {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * Generates a random, human-typeable temporary password for new accounts
 * (e.g. XK7P-QM2R-9VLT). Avoids visually ambiguous characters (0/O, 1/I/l).
 */
function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const groups = [];
  for (let g = 0; g < 3; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) {
      group += alphabet[crypto.randomInt(alphabet.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

function isPasswordStrongEnough(plaintext) {
  return typeof plaintext === 'string' && plaintext.length >= 10;
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateTempPassword,
  isPasswordStrongEnough,
};
