'use strict';

require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Fehlende Umgebungsvariable "${name}". Bitte in der .env-Datei setzen (siehe .env.example).`
    );
  }
  return value.trim();
}

function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function optionalBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value.trim().toLowerCase() === 'true';
}

const nodeEnv = optional('NODE_ENV', 'production');
const isProduction = nodeEnv === 'production';

let encryptionKeyHex;
let sessionSecret;

try {
  encryptionKeyHex = required('ENCRYPTION_KEY');
  sessionSecret = required('SESSION_SECRET');
} catch (err) {
  // Re-thrown below after other checks so the operator sees every problem,
  // not just the first one.
}

const problems = [];

if (!encryptionKeyHex) {
  problems.push('ENCRYPTION_KEY fehlt.');
} else if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
  problems.push(
    'ENCRYPTION_KEY muss ein 64-stelliger Hex-String sein (32 Byte / AES-256). ' +
      'Erzeugen mit: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

if (!sessionSecret) {
  problems.push('SESSION_SECRET fehlt.');
} else if (sessionSecret.length < 32) {
  problems.push('SESSION_SECRET sollte mindestens 32 Zeichen lang sein.');
}

const rpId = optional('RP_ID', null);
const rpOrigin = optional('RP_ORIGIN', null);
if (!rpId || !rpOrigin) {
  problems.push(
    'RP_ID und RP_ORIGIN muessen gesetzt sein (Domain bzw. volle Origin-URL, unter der die App erreichbar ist), ' +
      'damit Passkeys (WebAuthn) funktionieren, z.B. RP_ID=zeit.firma.example, RP_ORIGIN=https://zeit.firma.example'
  );
}

// Weitere Domains, unter denen dieselbe Installation erreichbar ist
// (kommagetrennte Liste voller Origin-URLs in RP_ORIGINS). Jede Domain
// fuehrt ihre eigenen Passkeys - das schreibt der WebAuthn-Standard so vor,
// Passkeys sind immer an genau eine Domain gebunden.
const extraOrigins = optional('RP_ORIGINS', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

// RP_ID und RP_ORIGIN muessen dieselbe Domain meinen. Weichen sie
// voneinander ab, funktionieren Passkeys nicht, ohne dass es auffaellt -
// deshalb lieber sofort beim Start abbrechen.
if (rpId && rpOrigin) {
  try {
    const originHost = new URL(rpOrigin).hostname;
    if (originHost !== rpId) {
      problems.push(
        `RP_ID ("${rpId}") und die Domain aus RP_ORIGIN ("${originHost}") stimmen nicht ueberein. ` +
          'Beide muessen dieselbe Adresse bezeichnen, sonst funktionieren Passkeys nicht.'
      );
    }
  } catch {
    problems.push(`RP_ORIGIN ist keine gueltige URL: "${rpOrigin}" (erwartet z.B. https://zeit.firma.example)`);
  }
}

const allOrigins = [rpOrigin, ...extraOrigins].filter(Boolean);
const originByHost = new Map();
for (const origin of allOrigins) {
  try {
    originByHost.set(new URL(origin).hostname, origin.replace(/\/$/, ''));
  } catch {
    problems.push(`RP_ORIGINS enthaelt keine gueltige URL: "${origin}" (erwartet z.B. https://tt.firma.example)`);
  }
}

if (problems.length > 0) {
  // Fail fast and loud - this is a security-relevant configuration error.
  // eslint-disable-next-line no-console
  console.error('\nKonfigurationsfehler:\n - ' + problems.join('\n - ') + '\n');
  process.exit(1);
}

module.exports = {
  nodeEnv,
  isProduction,
  port: parseInt(optional('PORT', '3000'), 10),
  dataDir: optional('DATA_DIR', '/app/data'),
  encryptionKey: Buffer.from(encryptionKeyHex, 'hex'),
  sessionSecret,
  cookieSecure: optionalBool('COOKIE_SECURE', isProduction),
  rpId,
  rpName: optional('RP_NAME', 'Zeiterfassung'),
  rpOrigin,
  // Host -> Origin fuer alle erlaubten Domains
  originByHost,
  sessionMaxAgeMs: parseInt(optional('SESSION_MAX_AGE_MINUTES', '600'), 10) * 60 * 1000,
  loginMaxAttempts: parseInt(optional('LOGIN_MAX_ATTEMPTS', '5'), 10),
  loginLockMinutes: parseInt(optional('LOGIN_LOCK_MINUTES', '15'), 10),
  auditRetentionDays: parseInt(optional('AUDIT_RETENTION_DAYS', '90'), 10),
  trustProxy: optionalBool('TRUST_PROXY', true),
  // Wenn true: Anfragen mit einem nicht konfigurierten Hostnamen werden
  // abgewiesen, statt die Anwendung unter beliebigen Namen auszuliefern.
  strictHost: optionalBool('STRICT_HOST', false),
};
