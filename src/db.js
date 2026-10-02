'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const session = require('express-session');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const dbPath = path.join(config.dataDir, 'app.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  username              TEXT NOT NULL UNIQUE,
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  totp_secret_enc       TEXT,
  totp_enabled          INTEGER NOT NULL DEFAULT 0,
  must_change_password  INTEGER NOT NULL DEFAULT 1,
  active                INTEGER NOT NULL DEFAULT 1,
  failed_login_count    INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  is_apprentice         INTEGER NOT NULL DEFAULT 0,
  auth_provider         TEXT NOT NULL DEFAULT 'local',
  external_id           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS backup_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS passkeys (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL UNIQUE,
  public_key     TEXT NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0,
  device_type    TEXT,
  backed_up      INTEGER NOT NULL DEFAULT 0,
  transports     TEXT,
  name           TEXT NOT NULL DEFAULT 'Passkey',
  rp_id          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at   TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date           TEXT NOT NULL,
  start_time          TEXT NOT NULL,
  end_time             TEXT NOT NULL,
  duration_minutes    INTEGER NOT NULL,
  description_enc     TEXT NOT NULL,
  jira_key            TEXT,
  transferred_to_jira INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, work_date);

-- Laufender Timer, serverseitig gespeichert: laeuft weiter, auch wenn der
-- Browser-Tab geschlossen oder das Geraet gewechselt wird. Pro Person max. einer.
CREATE TABLE IF NOT EXISTS active_timers (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  started_at       TEXT NOT NULL,
  work_date        TEXT NOT NULL,
  start_time       TEXT NOT NULL,
  description_enc  TEXT,
  jira_key         TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  event       TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  sid      TEXT PRIMARY KEY,
  sess     TEXT NOT NULL,
  expires  INTEGER NOT NULL
);
`);

const { labelFor, formatTimestamp } = require('./lib/auditLabels');

const insertAuditStmt = db.prepare(
  'INSERT INTO audit_log (user_id, event, detail, ip) VALUES (?, ?, ?, ?)'
);
const usernameStmt = db.prepare('SELECT username FROM users WHERE id = ?');

function formatAuditLine({ userId, event, detail, ip }) {
  const user = userId ? (usernameStmt.get(userId) || {}).username || `#${userId}` : '-';
  const parts = [
    `[AUDIT] ${formatTimestamp(new Date())}`,
    labelFor(event),
    `Benutzer: ${user}`,
    `IP: ${ip || '-'}`,
  ];
  if (detail) parts.push(`Details: ${detail}`);
  return parts.join(' | ');
}

// --- Migrationen fuer bereits bestehende Datenbanken -------------------
// Spalten, die nach dem ersten Release dazugekommen sind, werden hier
// nachgezogen, damit ein Update ohne Datenverlust moeglich ist.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('is_apprentice')) {
  db.exec('ALTER TABLE users ADD COLUMN is_apprentice INTEGER NOT NULL DEFAULT 0');
  // eslint-disable-next-line no-console
  console.log('[MIGRATION] Spalte "is_apprentice" (Azubi-Kennzeichnung) zur Tabelle users hinzugefuegt.');
}

const entryColumns = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
if (!entryColumns.includes('transferred_to_jira')) {
  db.exec('ALTER TABLE entries ADD COLUMN transferred_to_jira INTEGER NOT NULL DEFAULT 0');
  // eslint-disable-next-line no-console
  console.log('[MIGRATION] Spalte "transferred_to_jira" zur Tabelle entries hinzugefuegt.');
}
if (!entryColumns.includes('deleted_at')) {
  db.exec('ALTER TABLE entries ADD COLUMN deleted_at TEXT');
  // eslint-disable-next-line no-console
  console.log('[MIGRATION] Spalte "deleted_at" (Papierkorb fuer Undo) zur Tabelle entries hinzugefuegt.');
}

const passkeyColumns = db.prepare('PRAGMA table_info(passkeys)').all().map((c) => c.name);
if (!passkeyColumns.includes('rp_id')) {
  db.exec('ALTER TABLE passkeys ADD COLUMN rp_id TEXT');
  // eslint-disable-next-line no-console
  console.log('[MIGRATION] Spalte "rp_id" (Domain des Passkeys) zur Tabelle passkeys hinzugefuegt.');
}
// Passkeys aus der Zeit vor dieser Spalte koennen nur unter der Hauptdomain
// entstanden sein - entsprechend nachtragen, damit die Kontoseite bei jedem
// Passkey die zugehoerige Adresse anzeigt.
const backfilled = db
  .prepare('UPDATE passkeys SET rp_id = ? WHERE rp_id IS NULL')
  .run(config.rpId).changes;
if (backfilled > 0) {
  // eslint-disable-next-line no-console
  console.log(`[MIGRATION] ${backfilled} vorhandene(r) Passkey(s) der Domain "${config.rpId}" zugeordnet.`);
}

function audit(userId, event, detail, ip) {
  insertAuditStmt.run(userId ?? null, event, detail ?? null, ip ?? null);

  let line;
  try {
    line = formatAuditLine({ userId, event, detail, ip });
  } catch {
    return; // Konsolenausgabe ist Zusatz - darf die eigentliche Aktion nie stoeren
  }
  // eslint-disable-next-line no-console
  console.log(line);

  // CLI-Skripte laufen per "docker compose exec" als eigener Prozess, ihre
  // Ausgabe landet also nicht in "docker compose logs". Damit auch
  // CLI-Aktionen dort sichtbar sind, wird die Zeile zusaetzlich in die
  // Standardausgabe des Hauptprozesses (PID 1 im Container) geschrieben.
  if (process.env.AUDIT_MIRROR_TO_PID1 === '1' && process.pid !== 1) {
    try {
      fs.appendFileSync('/proc/1/fd/1', line + '\n');
    } catch {
      /* nicht verfuegbar (z.B. ausserhalb von Docker) - ignorieren */
    }
  }
}

/**
 * Loescht Audit-Log-Eintraege, die aelter als die konfigurierte
 * Aufbewahrungsfrist sind (Datensparsamkeit), und raeumt endgueltig
 * geloeschte Zeiteintraege aus dem Papierkorb.
 */
function runRetentionCleanup() {
  const days = config.auditRetentionDays;
  if (days > 0) {
    const info = db
      .prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)")
      .run(`-${days} days`);
    if (info.changes > 0) {
      // eslint-disable-next-line no-console
      console.log(`[AUFRAEUMEN] ${info.changes} Protokolleintrag/-eintraege aelter als ${days} Tage geloescht.`);
    }
  }
  // Undo-Fenster ist in Sekunden bemessen; nach einem Tag endgueltig entfernen.
  const purged = db
    .prepare("DELETE FROM entries WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-1 day')")
    .run();
  if (purged.changes > 0) {
    // eslint-disable-next-line no-console
    console.log(`[AUFRAEUMEN] ${purged.changes} geloeschte(r) Zeiteintrag/-eintraege endgueltig entfernt.`);
  }
}

/** Beendet alle Sitzungen eines bestimmten Nutzers (z.B. nach Passwort-Reset). */
const destroyUserSessionsStmt = db.prepare(
  "DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? OR json_extract(sess, '$.pending.userId') = ?"
);
function destroyUserSessions(userId) {
  return destroyUserSessionsStmt.run(userId, userId).changes;
}

/**
 * Minimal express-session Store backed by the same SQLite database, so the
 * app needs only one native dependency (better-sqlite3) instead of pulling
 * in a second, separately-maintained SQLite session-store package.
 */
class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this._get = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this._upsert = db.prepare(
      `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`
    );
    this._del = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._prune = db.prepare('DELETE FROM sessions WHERE expires < ?');
    this._pruneInterval = setInterval(() => {
      try {
        this._prune.run(Date.now());
      } catch {
        /* ignore prune errors */
      }
    }, 15 * 60 * 1000);
    this._pruneInterval.unref();
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge
        ? sessionData.cookie.maxAge
        : config.sessionMaxAgeMs;
      const expires = Date.now() + maxAge;
      this._upsert.run(sid, JSON.stringify(sessionData), expires);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this._del.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sessionData, cb) {
    this.set(sid, sessionData, cb);
  }
}

module.exports = { db, audit, destroyUserSessions, runRetentionCleanup, SqliteSessionStore };
