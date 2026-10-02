'use strict';

// Nutzerverwaltung per Kommandozeile.
//
//   docker compose exec app npm run user -- <befehl> [argumente]
//
// Befehle: siehe printHelp() unten oder "npm run user -- help".

const { db, audit, destroyUserSessions } = require('../db');
const { hashPassword, generateTempPassword } = require('../lib/passwords');
const { labelFor, formatTimestamp } = require('../lib/auditLabels');

const CLI_IP = 'CLI';

function printHelp() {
  console.log(`
Nutzerverwaltung (Zeiterfassung)

Aufruf:
  docker compose exec app npm run user -- <befehl> [argumente]

Befehle:
  list                        Alle Nutzer anzeigen
  reset-password <benutzer>   Temporaeres Passwort erzeugen (muss beim naechsten
                              Login geaendert werden), hebt Sperre auf,
                              beendet alle Sitzungen des Nutzers
  deactivate <benutzer>       Konto deaktivieren und sofort abmelden
  activate <benutzer>         Konto wieder aktivieren
  unlock <benutzer>           Sperre nach zu vielen Fehlversuchen aufheben
  azubi <benutzer> an|aus     Azubi-Kennzeichnung setzen/entfernen
                              (schaltet den Wochenbericht-Export frei)
  reset-2fa <benutzer>        2FA und alle Passkeys entfernen, Nutzer abmelden
  audit [anzahl]              Letzte Eintraege des Sicherheits-Protokolls
                              (Standard: 50)
  help                        Diese Hilfe

Neuen Nutzer anlegen:  docker compose exec app npm run create-admin
`);
}

function fail(message) {
  console.error(`Fehler: ${message}`);
  process.exit(1);
}

function findUser(username) {
  if (!username) fail('Benutzername fehlt. Beispiel: npm run user -- deactivate m.mustermann');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim().toLowerCase());
  if (!user) fail(`Benutzer "${username}" nicht gefunden. "npm run user -- list" zeigt alle Nutzer.`);
  return user;
}

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

const commands = {
  list() {
    const rows = db.prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count
      FROM users u ORDER BY u.username
    `).all();
    if (rows.length === 0) return console.log('Keine Nutzer vorhanden.');
    console.log(
      pad('Benutzer', 22) + pad('Name', 22) + pad('Rolle', 8) + pad('Azubi', 7) +
        pad('Status', 12) + pad('2FA', 5) + 'Passkeys'
    );
    console.log('-'.repeat(84));
    for (const u of rows) {
      const locked = u.locked_until && new Date(u.locked_until + 'Z') > new Date();
      const status = !u.active ? 'deaktiviert' : locked ? 'gesperrt' : 'aktiv';
      console.log(
        pad(u.username, 22) + pad(u.display_name, 22) + pad(u.role, 8) +
          pad(u.is_apprentice ? 'ja' : '-', 7) + pad(status, 12) +
          pad(u.totp_enabled ? 'an' : 'aus', 5) + u.passkey_count
      );
    }
  },

  async 'reset-password'(username) {
    const user = findUser(username);
    const tempPassword = generateTempPassword();
    const hash = await hashPassword(tempPassword);
    db.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 1,
         failed_login_count = 0, locked_until = NULL WHERE id = ?`
    ).run(hash, user.id);
    const ended = destroyUserSessions(user.id);
    audit(null, 'password_reset_by_admin', `${user.username} (per CLI)`, CLI_IP);
    console.log(`\nPasswort fuer "${user.username}" zurueckgesetzt.`);
    console.log(`Temporaeres Passwort: ${tempPassword}`);
    console.log(`Beendete Sitzungen:   ${ended}`);
    console.log('\nBitte sicher uebermitteln. Muss beim naechsten Login geaendert werden.');
  },

  deactivate(username) {
    const user = findUser(username);
    if (!user.active) return console.log(`"${user.username}" ist bereits deaktiviert.`);
    const activeAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
    if (user.role === 'admin' && activeAdmins <= 1) {
      console.log('Hinweis: Das ist der letzte aktive Admin. Neue Admins lassen sich per "npm run create-admin" anlegen.');
    }
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);
    const ended = destroyUserSessions(user.id);
    audit(null, 'user_deactivated', `${user.username} (per CLI)`, CLI_IP);
    console.log(`"${user.username}" deaktiviert. Beendete Sitzungen: ${ended}`);
  },

  activate(username) {
    const user = findUser(username);
    if (user.active) return console.log(`"${user.username}" ist bereits aktiv.`);
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(user.id);
    audit(null, 'user_activated', `${user.username} (per CLI)`, CLI_IP);
    console.log(`"${user.username}" aktiviert.`);
  },

  unlock(username) {
    const user = findUser(username);
    db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);
    audit(null, 'user_unlocked', `${user.username} (per CLI)`, CLI_IP);
    console.log(`Sperre fuer "${user.username}" aufgehoben.`);
  },

  azubi(username, mode) {
    const user = findUser(username);
    if (!['an', 'aus'].includes(String(mode || '').toLowerCase())) {
      fail('Bitte "an" oder "aus" angeben. Beispiel: npm run user -- azubi m.mustermann an');
    }
    const enable = String(mode).toLowerCase() === 'an';
    db.prepare('UPDATE users SET is_apprentice = ? WHERE id = ?').run(enable ? 1 : 0, user.id);
    audit(
      null,
      enable ? 'user_apprentice_enabled' : 'user_apprentice_disabled',
      `${user.username} (per CLI)`,
      CLI_IP
    );
    console.log(
      enable
        ? `"${user.username}" ist jetzt als Azubi gekennzeichnet und sieht den Wochenbericht.`
        : `Azubi-Kennzeichnung fuer "${user.username}" entfernt.`
    );
  },

  'reset-2fa'(username) {
    const user = findUser(username);
    db.transaction(() => {
      db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0 WHERE id = ?').run(user.id);
      db.prepare('DELETE FROM backup_codes WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(user.id);
    })();
    const ended = destroyUserSessions(user.id);
    audit(null, 'user_2fa_reset_by_admin', `${user.username} (per CLI)`, CLI_IP);
    console.log(`2FA und Passkeys fuer "${user.username}" entfernt. Beendete Sitzungen: ${ended}`);
  },

  audit(countArg) {
    const limit = Math.min(Math.max(parseInt(countArg, 10) || 50, 1), 1000);
    const rows = db.prepare(`
      SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?
    `).all(limit).reverse();
    if (rows.length === 0) return console.log('Protokoll ist leer.');
    for (const r of rows) {
      // created_at ist UTC (SQLite datetime('now'))
      const when = formatTimestamp(new Date(r.created_at.replace(' ', 'T') + 'Z'));
      const parts = [when, labelFor(r.event), `Benutzer: ${r.username || '-'}`, `IP: ${r.ip || '-'}`];
      if (r.detail) parts.push(`Details: ${r.detail}`);
      console.log(parts.join(' | '));
    }
  },

  help: printHelp,
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !commands[command]) {
    if (command) console.error(`Unbekannter Befehl: ${command}`);
    printHelp();
    process.exit(command ? 1 : 0);
  }
  await commands[command](...args);
  process.exit(0);
}

main().catch((err) => fail(err.message || String(err)));
