'use strict';

// Interactive CLI to create a user account (used to bootstrap the first
// admin, since the web admin panel itself requires an existing admin).
//
// Usage (inside the running container):
//   docker compose exec app npm run create-admin

const readline = require('readline');
const { db, audit } = require('../db');
const { hashPassword, generateTempPassword } = require('../lib/passwords');

const rl = readline.createInterface({ input: process.stdin });
const lineQueue = [];
let waiter = null;
rl.on('line', (line) => {
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(line);
  } else {
    lineQueue.push(line);
  }
});
function ask(promptText) {
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    if (lineQueue.length) resolve(lineQueue.shift());
    else waiter = resolve;
  });
}

const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

async function main() {
  console.log('=== Neuen Benutzer anlegen ===\n');

  let username;
  while (true) {
    username = (await ask('Benutzername (z.B. m.mustermann): ')).trim().toLowerCase();
    if (USERNAME_RE.test(username)) break;
    console.log('Ungueltig. Erlaubt: a-z, 0-9, Punkt, Bindestrich, Unterstrich, 3-40 Zeichen.');
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.log(`Benutzername "${username}" existiert bereits. Abbruch.`);
    rl.close();
    process.exit(1);
  }

  const displayName = (await ask('Anzeigename (z.B. Max Mustermann): ')).trim() || username;
  const roleAnswer = (await ask('Rolle [user/admin] (Standard: user): ')).trim().toLowerCase();
  const role = roleAnswer === 'admin' ? 'admin' : 'user';

  const tempPassword = generateTempPassword();
  const hash = await hashPassword(tempPassword);

  db.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, must_change_password)
     VALUES (?, ?, ?, ?, 1)`
  ).run(username, displayName, hash, role);
  audit(null, 'user_created', `${username} (${role}, per CLI)`, 'CLI');

  console.log('\nBenutzer angelegt:');
  console.log(`  Benutzername:      ${username}`);
  console.log(`  Anzeigename:       ${displayName}`);
  console.log(`  Rolle:             ${role}`);
  console.log(`  Temporaeres Passwort: ${tempPassword}`);
  console.log(
    '\nBitte dieses Passwort sicher (z.B. persoenlich oder per verschluesseltem Kanal) an die Person ' +
      'uebermitteln. Es muss beim ersten Login geaendert werden und wird hier nicht gespeichert.'
  );

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fehler:', err);
  process.exit(1);
});
