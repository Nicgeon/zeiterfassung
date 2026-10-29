'use strict';

// Berichtsheft-Text aus den erfassten Einträgen erzeugen (anonymisiert, optional mit KI).
//
//   lokal:   npm run berichtsheft
//   Docker:  docker compose exec -it app npm run berichtsheft -- --benutzer m.mustermann
//
// Hilfe: npm run berichtsheft -- hilfe

require('dotenv').config();

const fs = require('fs');
const path = require('path');

// Ohne Server-Schlüssel (ENCRYPTION_KEY) und ohne ausdrückliche Angabe wird der lokale Modus
// angenommen - dort liegen Datenbank und Schlüssel im Datenordner des eigenen Benutzers.
if (process.argv.includes('--lokal') || (!process.env.ENCRYPTION_KEY && process.env.LOCAL_MODE === undefined)) {
  process.env.LOCAL_MODE = 'true';
}

if (process.env.LOCAL_MODE === 'true') {
  const { defaultLocalDataDir } = require('../lib/localKeys');
  const dir = process.env.DATA_DIR || defaultLocalDataDir();
  if (!fs.existsSync(path.join(dir, 'app.db'))) {
    console.error(
      `Keine Datenbank gefunden (${path.join(dir, 'app.db')}).\n` +
        'Bitte zuerst die Zeiterfassung starten und Einträge erfassen – oder DATA_DIR setzen.'
    );
    process.exit(1);
  }
}

const config = require('../config');
const { db } = require('../db');
const { encryptField, decryptField } = require('../lib/crypto');
const { makeStore } = require('../lib/berichtsheft/store');
const { generate, listModels } = require('../lib/berichtsheft/providers');
const { copyToClipboard } = require('../lib/berichtsheft/report');
const { createUi } = require('../lib/berichtsheft/ui');
const { runCli, parseArgs } = require('../lib/berichtsheft/cli');
const { todayLocal } = require('../lib/dates');

const auditStmt = db.prepare('INSERT INTO audit_log (user_id, event, detail, ip) VALUES (?, ?, ?, ?)');

function findUser(name) {
  if (name) {
    const user = db.prepare('SELECT id, username FROM users WHERE username = ? AND active = 1').get(String(name).trim().toLowerCase());
    if (!user) throw new Error(`Benutzer "${name}" nicht gefunden oder deaktiviert ("npm run user -- list" zeigt alle).`);
    return user;
  }
  if (config.localMode) {
    const user = db.prepare("SELECT id, username FROM users WHERE username = 'lokal'").get();
    if (!user) throw new Error('Der lokale Benutzer existiert noch nicht – bitte die Zeiterfassung einmal starten.');
    return user;
  }
  const users = db.prepare('SELECT id, username FROM users WHERE active = 1 ORDER BY id').all();
  if (users.length === 1) return users[0];
  throw new Error(`Es gibt mehrere Konten (${users.map((u) => u.username).join(', ')}) – bitte --benutzer angeben.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const ui = createUi();
  let code = 1;
  try {
    let userName;
    try {
      userName = parseArgs(argv).flags.benutzer;
    } catch { /* Fehler meldet runCli */ }
    const user = findUser(userName);
    code = await runCli({
      argv,
      ui,
      userId: user.id,
      store: makeStore(db, { encryptField, decryptField }),
      dataDir: config.dataDir,
      env: process.env,
      today: todayLocal(),
      generate,
      listModels,
      copy: copyToClipboard,
      // Protokolleintrag ohne Konsolenausgabe (die würde die Rückfragen stören)
      audit: (userId, event, detail) => auditStmt.run(userId, event, detail, 'CLI'),
    });
  } catch (err) {
    console.error(`Fehler: ${err.message}`);
  } finally {
    ui.close();
  }
  process.exit(code);
}

main();
