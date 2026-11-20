'use strict';

// Erinnerungen gegen Vergessen: Auswahl mit fester Uhrzeit gegen eine kleine Datenbank im Speicher.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createWorkReminders, normalize, DEFAULTS } = require('../src/lib/workReminders');

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, user_id INTEGER, work_date TEXT, start_time TEXT, end_time TEXT,
      duration_minutes INTEGER, description_enc TEXT, jira_key TEXT, transferred_to_jira INTEGER DEFAULT 0,
      school_day INTEGER DEFAULT 0, segments_json TEXT, deleted_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE active_timers (user_id INTEGER PRIMARY KEY, started_at TEXT, work_date TEXT, start_time TEXT,
      description_enc TEXT, jira_key TEXT, task_id INTEGER);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id INTEGER, title_enc TEXT);
    CREATE TABLE reminder_settings (user_id INTEGER PRIMARY KEY, config_json TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE reminder_log (user_id INTEGER, kind TEXT, ref TEXT, sent_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (user_id, kind, ref));
    INSERT INTO users (id) VALUES (1);
  `);
  const r = createWorkReminders({ db, decryptField: (v) => v });
  return { db, r };
}
// lokale Zeit -> SQLite-UTC-Zeitstempel ("JJJJ-MM-TT HH:MM:SS")
const sqlUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const at = (hm, date = '2026-11-20') => new Date(`${date}T${hm}:00`); // Freitag, lokale Zeit
const addEntry = (db, o) => db.prepare(
  `INSERT INTO entries (user_id, work_date, start_time, end_time, duration_minutes, description_enc, jira_key, transferred_to_jira, school_day, segments_json, created_at, updated_at)
   VALUES (1, @date, @s, @e, @dur, @text, @key, @tr, @school, @seg, @created, @created)`
).run({ date: '2026-11-20', key: null, tr: 0, school: 0, seg: null, text: 'x', ...o });

test('Einstellungen: Standardwerte, Prüfung der Eingaben, Speichern', () => {
  const { r } = setup();
  assert.deepEqual(r.settings(1), { ...DEFAULTS });
  assert.equal(normalize({ timerHours: 0 }).timerHours, 3);
  assert.equal(normalize({ idleMinutes: 5 }).idleMinutes, 45);
  assert.equal(normalize({ endTime: '25:00' }).endTime, '16:30');
  assert.deepEqual([normalize({ workFrom: '18:00', workTo: '08:00' }).workFrom], ['07:00']);
  const saved = r.save(1, { idle: false, endTime: '17:15', timerHours: '2' });
  assert.equal(saved.idle, false);
  assert.equal(saved.endTime, '17:15');
  assert.equal(saved.timerHours, 2);
  assert.equal(r.settings(1).endTime, '17:15');
});

test('Timer läuft lange: nach 3 Stunden, nach 6 Stunden erneut, nie doppelt', () => {
  const { db, r } = setup();
  db.prepare('INSERT INTO active_timers VALUES (1, ?, ?, ?, ?, ?, NULL)').run(at('08:00').toISOString(), '2026-11-20', '08:00', 'Netzwerkdoku', 'IT-5');
  assert.equal(r.take(at('10:59')).length, 0);
  let msgs = r.take(at('11:01'));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].title, 'Timer läuft seit 3:01 Std.');
  assert.match(msgs[0].body, /„Netzwerkdoku“ – noch dran\?/);
  assert.equal(r.take(at('11:30')).length, 0, 'nicht doppelt');
  msgs = r.take(at('14:05'));
  assert.equal(msgs.length, 1, 'nach 6 Stunden erneut');
  r.save(1, { timerLong: false });
  assert.equal(r.take(at('17:10')).filter((m) => m.kind === 'timer').length, 0, 'abgeschaltet');
});

test('Lange nichts erfasst: nur Mo–Fr in der Arbeitszeit, nach dem ersten Eintrag, einmal je Lücke', () => {
  const { db, r } = setup();
  assert.equal(r.take(at('10:00')).length, 0, 'ohne Eintrag heute keine Meldung');
  addEntry(db, { s: '08:00', e: '09:30', dur: 90, seg: JSON.stringify([['08:00', '09:30']]), created: sqlUtc(at('09:30')) });
  assert.equal(r.take(at('10:10')).filter((m) => m.kind === 'idle').length, 0, '40 Minuten: noch nicht');
  let msgs = r.take(at('10:16')).filter((m) => m.kind === 'idle');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].title, 'Seit 46 Min. nichts erfasst');
  assert.match(msgs[0].body, /Zuletzt um 09:30 Uhr/);
  assert.equal(r.take(at('11:00')).filter((m) => m.kind === 'idle').length, 0, 'gleiche Lücke nicht noch einmal');
  // neuer Eintrag (nachgetragen um 11:30) -> neue Lücke
  addEntry(db, { s: '10:00', e: '11:00', dur: 60, created: sqlUtc(at('11:30')) });
  assert.equal(r.take(at('12:20')).filter((m) => m.kind === 'idle').length, 1);
  // Timer läuft -> keine Lücke
  db.prepare('INSERT INTO active_timers VALUES (1, ?, ?, ?, ?, ?, NULL)').run(at('13:30').toISOString(), '2026-11-20', '13:30', '', null);
  assert.equal(r.take(at('15:00')).filter((m) => m.kind === 'idle').length, 0);
  db.prepare('DELETE FROM active_timers').run();
  // nach Arbeitsende und am Wochenende nicht
  assert.equal(r.take(at('17:30')).filter((m) => m.kind === 'idle').length, 0);
  addEntry(db, { date: '2026-11-21', s: '08:00', e: '09:00', dur: 60, created: sqlUtc(at('09:00', '2026-11-21')) });
  assert.equal(r.take(at('11:00', '2026-11-21')).filter((m) => m.kind === 'idle').length, 0, 'Samstag');
});

test('Feierabend: offene Einträge (ohne Berufsschule) oder laufender Timer, einmal am Tag', () => {
  const { db, r } = setup();
  addEntry(db, { s: '08:00', e: '09:00', dur: 60, tr: 1, created: sqlUtc(at('09:00')) });
  addEntry(db, { s: '09:00', e: '09:45', dur: 45, created: sqlUtc(at('09:45')) });
  addEntry(db, { s: '10:00', e: '12:00', dur: 120, school: 1, created: sqlUtc(at('12:00')) });
  assert.equal(r.take(at('16:00')).filter((m) => m.kind === 'end').length, 0, 'vor Feierabend nicht');
  let msgs = r.take(at('16:31')).filter((m) => m.kind === 'end');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].title, 'Feierabend? Noch nicht alles in Jira');
  assert.equal(msgs[0].body, '1 Eintrag (45 Min.) noch nicht in Jira.');
  assert.equal(r.take(at('17:00')).filter((m) => m.kind === 'end').length, 0, 'einmal am Tag');

  const second = setup();
  addEntry(second.db, { s: '08:00', e: '09:00', dur: 60, tr: 1, created: sqlUtc(at('09:00')) });
  assert.equal(second.r.take(at('16:45')).filter((m) => m.kind === 'end').length, 0, 'alles in Jira: keine Meldung');
  second.db.prepare('INSERT INTO active_timers VALUES (1, ?, ?, ?, ?, ?, NULL)').run(at('16:00').toISOString(), '2026-11-20', '16:00', 'Doku', null);
  second.db.prepare('DELETE FROM reminder_log').run();
  msgs = second.r.take(at('16:50')).filter((m) => m.kind === 'end');
  assert.equal(msgs[0].title, 'Feierabend? Der Timer läuft noch');
});
