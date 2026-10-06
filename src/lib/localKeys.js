'use strict';

// Datenordner und Schluessel fuer den lokalen Betrieb (LOCAL_MODE).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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

module.exports = { defaultLocalDataDir, loadOrCreateLocalKeys };
