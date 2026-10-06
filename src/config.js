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

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const nodeEnv = optional('NODE_ENV', 'production');
const isProduction = nodeEnv === 'production';

// Lokaler Modus: Die Anwendung laeuft auf dem eigenen Rechner, ist nur ueber
// localhost erreichbar und braucht weder Domain noch Proxy noch Zertifikate.
// Es gibt genau einen Nutzer (den, der den Rechner bedient); der Schutz der
// Daten kommt von der Verschluesselung und dem Betriebssystem-Benutzerkonto.
const localMode = optionalBool('LOCAL_MODE', false);

function defaultLocalDataDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Zeiterfassung');
  }
  return path.join(os.homedir(), '.zeiterfassung');
}

/**
 * Lokaler Modus: Schluessel beim ersten Start erzeugen und in der Datei
 * keys.json im Datenordner ablegen (nur fuer den eigenen Benutzer lesbar).
 * Existiert schon eine Datenbank, aber keine Schluesseldatei, wird NICHT still
 * ein neuer Schluessel erzeugt - die vorhandenen Daten waeren sonst
 * unwiederbringlich unlesbar.
 */
function loadOrCreateLocalKeys(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, 'keys.json');
  if (fs.existsSync(keyFile)) {
    const parsed = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    return { encryptionKey: parsed.encryptionKey, sessionSecret: parsed.sessionSecret };
  }
  if (fs.existsSync(path.join(dir, 'app.db'))) {
    console.error(
      '\nKonfigurationsfehler:\n - Im Datenordner "' + dir + '" liegt eine Datenbank, aber die ' +
        'Schluesseldatei keys.json fehlt. Ohne den urspruenglichen Schluessel sind die Eintraege nicht ' +
        'lesbar. Bitte keys.json aus einer Sicherung zurueckkopieren. Es wird bewusst kein neuer ' +
        'Schluessel erzeugt.\n'
    );
    process.exit(1);
  }
  const keys = {
    encryptionKey: crypto.randomBytes(32).toString('hex'),
    sessionSecret: crypto.randomBytes(48).toString('hex'),
  };
  fs.writeFileSync(keyFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

const dataDir = optional('DATA_DIR', localMode ? defaultLocalDataDir() : '/app/data');

let encryptionKeyHex;
let sessionSecret;

if (localMode) {
  const keys = loadOrCreateLocalKeys(dataDir);
  encryptionKeyHex = optional('ENCRYPTION_KEY', keys.encryptionKey);
  sessionSecret = optional('SESSION_SECRET', keys.sessionSecret);
} else {
  try {
    encryptionKeyHex = required('ENCRYPTION_KEY');
    sessionSecret = required('SESSION_SECRET');
  } catch (err) {
    // Re-thrown below after other checks so the operator sees every problem,
    // not just the first one.
  }
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

const port = parseInt(optional('PORT', localMode ? '4711' : '3000'), 10);
const rpId = localMode ? 'localhost' : optional('RP_ID', null);
const rpOrigin = localMode ? `http://localhost:${port}` : optional('RP_ORIGIN', null);
if (!localMode && (!rpId || !rpOrigin)) {
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
if (!localMode && rpId && rpOrigin) {
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
  localMode,
  port,
  // Lokal nur auf dem eigenen Rechner lauschen, nie im Netzwerk.
  host: localMode ? '127.0.0.1' : null,
  dataDir,
  encryptionKey: Buffer.from(encryptionKeyHex, 'hex'),
  sessionSecret,
  cookieSecure: localMode ? false : optionalBool('COOKIE_SECURE', isProduction),
  rpId,
  rpName: optional('RP_NAME', 'Zeiterfassung'),
  rpOrigin,
  // Host -> Origin fuer alle erlaubten Domains
  originByHost,
  sessionMaxAgeMs: parseInt(optional('SESSION_MAX_AGE_MINUTES', '600'), 10) * 60 * 1000,
  loginMaxAttempts: parseInt(optional('LOGIN_MAX_ATTEMPTS', '5'), 10),
  loginLockMinutes: parseInt(optional('LOGIN_LOCK_MINUTES', '15'), 10),
  auditRetentionDays: parseInt(optional('AUDIT_RETENTION_DAYS', '90'), 10),
  trustProxy: localMode ? false : optionalBool('TRUST_PROXY', true),
  // Wenn true: Anfragen mit einem nicht konfigurierten Hostnamen werden
  // abgewiesen, statt die Anwendung unter beliebigen Namen auszuliefern.
  strictHost: localMode ? true : optionalBool('STRICT_HOST', false),
};
