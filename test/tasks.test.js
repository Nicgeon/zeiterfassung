'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const { normalizeRepeat, nextDue, addMonths } = require('../src/lib/taskRepeat');
const { takeDueReminders, formatReminders, startReminderLoop, localStamp } = require('../src/lib/taskReminders');
const { buildCommand, notify } = require('../src/lib/notify');
const { createRouter } = require('../src/routes/tasks');
const { convertTicketLinks } = require('../public/js/tickets');

const fake = { encryptField: (s) => 'enc:' + Buffer.from(s).toString('base64'), decryptField: (s) => Buffer.from(s.slice(4), 'base64').toString() };

const SCHEMA = `CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title_enc TEXT NOT NULL, jira_key TEXT, due_date TEXT, due_time TEXT,
  priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', done_at TEXT, repeat_json TEXT, snooze_until TEXT,
  reminded_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`;

// --- Wiederholung -----------------------------------------------------------------------------------

test('Wiederholung prüfen: gültige Angaben, Standardmodus, klare Fehler', () => {
  assert.equal(normalizeRepeat(null), null);
  assert.deepEqual(normalizeRepeat({ every: 2, unit: 'week' }), { every: 2, unit: 'week', mode: 'due' });
  assert.throws(() => normalizeRepeat({ every: 0, unit: 'day' }), /Abstand/);
  assert.throws(() => normalizeRepeat({ every: 1, unit: 'year' }), /Einheit/);
  assert.throws(() => normalizeRepeat({ every: 1, unit: 'day', mode: 'x' }), /Modus/);
});

test('nächster Termin: ab Termin (verpasste überspringen), ab Erledigt-Tag, Monatsende', () => {
  const week = { every: 1, unit: 'week', mode: 'due' };
  assert.equal(nextDue('2026-11-13', week, '2026-11-13'), '2026-11-20');
  assert.equal(nextDue('2026-11-13', week, '2026-11-12'), '2026-11-20'); // früh erledigt: trotzdem der nächste Termin
  assert.equal(nextDue('2026-10-01', week, '2026-11-13'), '2026-11-19'); // Wochen verpasst: nie in der Vergangenheit
  assert.equal(nextDue('2026-11-01', { every: 3, unit: 'day', mode: 'done' }, '2026-11-13'), '2026-11-16');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-12-15', 2), '2027-02-15');
  assert.equal(nextDue('2026-01-31', { every: 1, unit: 'month', mode: 'due' }, '2026-01-31'), '2026-02-28');
  assert.equal(nextDue(null, week, '2026-11-13'), '2026-11-20');
});

// --- Erinnerungen -------------------------------------------------------------------------------------

function memDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}
const add = (db, o) => db.prepare('INSERT INTO tasks (user_id, title_enc, jira_key, due_date, due_time, status, reminded_at, snooze_until, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(o.user || 1, fake.encryptField(o.title || ''), o.key || null, o.date || null, o.time || null, o.status || 'open', o.reminded || null, o.snooze || null, o.deleted || null).lastInsertRowid;
const at = (s) => new Date(s.replace(' ', 'T') + ':00');

test('Erinnerungen: fällig nach Uhrzeit bzw. 09:00, nur einmal, nicht für Erledigtes/Gelöschtes/Ohne Datum', () => {
  const db = memDb();
  const a = add(db, { title: 'Mit Uhrzeit', date: '2026-11-18', time: '14:00' });
  const b = add(db, { title: 'Nur Datum', date: '2026-11-18' });
  add(db, { title: 'Später', date: '2026-11-19' });
  add(db, { title: 'Erledigt', date: '2026-11-18', status: 'done' });
  add(db, { title: 'Gelöscht', date: '2026-11-18', deleted: '2026-11-17 10:00:00' });
  add(db, { title: 'Ohne Datum' });

  assert.deepEqual(takeDueReminders(db, fake.decryptField, at('2026-11-18 08:59')), []);
  let r = takeDueReminders(db, fake.decryptField, at('2026-11-18 09:00'));
  assert.deepEqual(r.map((x) => x.id), [b]);
  assert.equal(r[0].title, 'Nur Datum');
  assert.deepEqual(takeDueReminders(db, fake.decryptField, at('2026-11-18 09:01')), []); // nur einmal
  r = takeDueReminders(db, fake.decryptField, at('2026-11-18 14:00'));
  assert.deepEqual(r.map((x) => x.id), [a]);
});

test('Erinnerungen: nach Neustart des Programms werden verpasste Aufgaben nachgeholt (als überfällig)', () => {
  const db = memDb();
  add(db, { title: 'Gestern fällig', date: '2026-11-17', time: '10:00' });
  const r = takeDueReminders(db, fake.decryptField, at('2026-11-18 08:00'));
  assert.equal(r.length, 1);
  assert.equal(r[0].overdue, true);
  assert.equal(formatReminders(r).title, 'Aufgabe überfällig');
});

test('Später erinnern: Aufgabe schweigt bis snooze_until, meldet sich dann erneut', () => {
  const db = memDb();
  const id = add(db, { title: 'Snooze', date: '2026-11-18', time: '10:00', reminded: '2026-11-18 10:00' });
  db.prepare('UPDATE tasks SET snooze_until = ? WHERE id = ?').run('2026-11-18 10:30', id);
  assert.deepEqual(takeDueReminders(db, fake.decryptField, at('2026-11-18 10:20')), []);
  assert.equal(takeDueReminders(db, fake.decryptField, at('2026-11-18 10:30')).length, 1);
  assert.deepEqual(takeDueReminders(db, fake.decryptField, at('2026-11-18 10:31')), []);
});

test('Sammelnachricht und Erinnerungsschleife', () => {
  assert.equal(formatReminders([]), null);
  const many = Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, jiraKey: null, overdue: false }));
  const m = formatReminders(many);
  assert.equal(m.title, '6 Aufgaben fällig');
  assert.match(m.body, /… und 2 weitere/);

  const db = memDb();
  add(db, { title: 'Jetzt', key: 'IT-1', date: '2026-11-18', time: '09:00' });
  const seen = [];
  const stop = startReminderLoop({ db, decryptField: fake.decryptField, notify: (n) => seen.push(n), intervalMs: 3_600_000, now: () => at('2026-11-18 09:05') });
  stop();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, 'Jetzt [IT-1]');
});

test('Benachrichtigung: Befehl je Plattform, Texte nur über Umgebung bzw. Argumente, Fehler werfen nicht', () => {
  assert.equal(buildCommand('win32').cmd, 'powershell.exe');
  assert.equal(buildCommand('darwin').cmd, 'osascript');
  assert.equal(buildCommand('linux').cmd, 'notify-send');
  const calls = [];
  const spawnImpl = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  assert.equal(notify({ title: 'T "x"', body: "B ' $(rm)" }, { platform: 'win32', spawnImpl }), true);
  assert.equal(calls[0].opts.env.ZEIT_TITLE, 'T "x"');
  assert.ok(!calls[0].args.join(' ').includes('$(rm)'), 'Text steht nicht im Befehl');
  notify({ title: 'T', body: 'B' }, { platform: 'linux', spawnImpl });
  assert.deepEqual(calls[1].args.slice(-2), ['T', 'B']);
  assert.equal(notify({ title: 'T' }, { platform: 'linux', spawnImpl: () => { throw new Error('weg'); } }), false);
});

// --- Schnittstelle ----------------------------------------------------------------------------------------

async function withApp(fn, nowFn = () => new Date(2026, 10, 18, 12, 0)) {
  const db = memDb();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: Number(req.get('x-user') || 1) }; next(); });
  app.use('/api/tasks', createRouter({ db, ...fake, convertTicketLinks, now: nowFn }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/tasks`;
  const call = async (method, path, body, user) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': String(user) } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try { await fn({ call, db }); } finally { server.close(); }
}

test('Aufgaben anlegen, prüfen, sortieren; Titel liegt verschlüsselt in der Datenbank', async () => {
  await withApp(async ({ call, db }) => {
    let r = await call('POST', '/', { title: '' });
    assert.equal(r.status, 400);
    r = await call('POST', '/', { title: 'x', due_time: '10:00' });
    assert.match(r.body.error, /braucht ein Datum/);
    r = await call('POST', '/', { title: 'x', due_date: '2026-02-31' });
    assert.equal(r.status, 400);
    r = await call('POST', '/', { title: 'x', repeat: { every: 1, unit: 'week' } });
    assert.match(r.body.error, /Fälligkeitsdatum/);

    await call('POST', '/', { title: 'Ohne Datum' });
    await call('POST', '/', { title: 'Später', due_date: '2026-11-25' });
    r = await call('POST', '/', { title: 'Backup prüfen', jira_key: 'https://firma.atlassian.net/browse/IT-77', due_date: '2026-11-18', due_time: '14:00', priority: 1 });
    assert.equal(r.status, 201);
    assert.equal(r.body.task.jiraKey, 'IT-77', 'Jira-Link wird zur Ticketnummer');
    await call('POST', '/', { jira_key: 'IT-5', due_date: '2026-11-17' });

    r = await call('GET', '/');
    assert.deepEqual(r.body.tasks.map((t) => t.title), ['', 'Backup prüfen', 'Später', 'Ohne Datum']);
    assert.equal(r.body.today, '2026-11-18');
    assert.ok(db.prepare('SELECT title_enc FROM tasks').all().every((x) => x.title_enc.startsWith('enc:')));
  });
});

test('Aufgaben sind pro Person getrennt', async () => {
  await withApp(async ({ call }) => {
    const { body } = await call('POST', '/', { title: 'Meins' }, 1);
    assert.equal((await call('GET', '/', null, 2)).body.tasks.length, 0);
    assert.equal((await call('PUT', `/${body.task.id}`, { title: 'Fremd' }, 2)).status, 404);
    assert.equal((await call('PATCH', `/${body.task.id}/done`, {}, 2)).status, 404);
    assert.equal((await call('DELETE', `/${body.task.id}`, null, 2)).status, 404);
  });
});

test('Ändern: Termin verschieben setzt die Erinnerung zurück; Abhaken und Wiedereröffnen', async () => {
  await withApp(async ({ call, db }) => {
    const { body } = await call('POST', '/', { title: 'A', due_date: '2026-11-18', due_time: '10:00' });
    const id = body.task.id;
    db.prepare("UPDATE tasks SET reminded_at = '2026-11-18 10:00' WHERE id = ?").run(id);
    let r = await call('PUT', `/${id}`, { title: 'A2' });
    assert.equal(r.body.task.title, 'A2');
    assert.equal(db.prepare('SELECT reminded_at FROM tasks WHERE id = ?').get(id).reminded_at, '2026-11-18 10:00');
    await call('PUT', `/${id}`, { due_date: '2026-11-19' });
    assert.equal(db.prepare('SELECT reminded_at FROM tasks WHERE id = ?').get(id).reminded_at, null);

    r = await call('PATCH', `/${id}/done`, { done: true });
    assert.equal(r.body.task.status, 'done');
    assert.equal(r.body.next, null);
    assert.equal((await call('GET', '/')).body.tasks.length, 0);
    assert.equal((await call('GET', '/?scope=done')).body.tasks.length, 1);
    r = await call('PATCH', `/${id}/done`, { done: false });
    assert.equal(r.body.task.status, 'open');
  });
});

test('Abhaken einer wiederkehrenden Aufgabe legt die nächste an', async () => {
  await withApp(async ({ call }) => {
    const { body } = await call('POST', '/', { title: 'Wöchentlich', jira_key: 'IT-1', due_date: '2026-11-13', due_time: '09:30', repeat: { every: 1, unit: 'week', mode: 'due' } });
    const r = await call('PATCH', `/${body.task.id}/done`, { done: true });
    assert.equal(r.body.next.dueDate, '2026-11-20');
    assert.equal(r.body.next.dueTime, '09:30');
    assert.equal(r.body.next.title, 'Wöchentlich');
    assert.deepEqual(r.body.next.repeat, { every: 1, unit: 'week', mode: 'due' });
    const list = (await call('GET', '/')).body.tasks;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, r.body.next.id);
    // zweites Abhaken derselben Aufgabe erzeugt keine weitere
    assert.equal((await call('PATCH', `/${body.task.id}/done`, { done: true })).body.next, null);
  });
});

test('Später erinnern, Papierkorb mit kurzer Rückgängig-Frist', async () => {
  await withApp(async ({ call, db }) => {
    const { body } = await call('POST', '/', { title: 'S', due_date: '2026-11-18', due_time: '11:00' });
    const id = body.task.id;
    assert.equal((await call('POST', `/${id}/snooze`, { minutes: 1 })).status, 400);
    const r = await call('POST', `/${id}/snooze`, { minutes: 30 });
    assert.equal(r.body.task.snoozeUntil, '2026-11-18 12:30');

    assert.equal((await call('DELETE', `/${id}`)).status, 200);
    assert.equal((await call('GET', '/')).body.tasks.length, 0);
    assert.equal((await call('POST', `/${id}/restore`)).status, 200);
    assert.equal((await call('GET', '/')).body.tasks.length, 1);
    await call('DELETE', `/${id}`);
    db.prepare("UPDATE tasks SET deleted_at = datetime('now', '-10 minutes') WHERE id = ?").run(id);
    assert.equal((await call('POST', `/${id}/restore`)).status, 404);
  });
});
