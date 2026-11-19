'use strict';

// Echte Arbeitszeiträume (Teile) und Verknüpfung Eintrag <-> Aufgabe, über den echten Server im lokalen Betrieb.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const segments = require('../src/lib/segments');

test('segments: bereinigen, sortieren, einzelner Zeitraum (direkt gestoppt = 1 Minute)', () => {
  assert.deepEqual(segments.normalize([['12:35', '13:05'], ['10:35', '11:05'], ['x', '1'], ['09:00', '08:00']]), [['10:35', '11:05'], ['12:35', '13:05']]);
  assert.equal(segments.normalize([]), null);
  assert.equal(segments.parse('kaputt'), null);
  assert.deepEqual(segments.single('09:00', '09:00'), [['09:00', '09:01']]);
  assert.equal(segments.single('9:00', '10:00'), null);
});

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Server: Teile beim Timer (mit Unterbrechung), beim Nachtragen, beim Bearbeiten; Aufgabe am Eintrag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-seg-'));
  const port = await freePort();
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), LOCAL_MODE: 'true', UPDATE_CHECK: 'false', ZEIT_NO_REMINDERS: '1', OPEN_BROWSER: '0' };
  delete env.ENCRYPTION_KEY;
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ok = false;
    for (let i = 0; i < 80 && !ok; i++) { try { ok = (await fetch(`${base}/api/health`)).ok; } catch { await sleep(150); } }
    assert.ok(ok, 'Server startet');
    const tokenRes = await fetch(`${base}/api/csrf-token`);
    const cookie = tokenRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const { csrfToken } = await tokenRes.json();
    const call = async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    };
    const day = '2026-11-19';

    const task = (await call('POST', '/api/tasks', { title: 'Updates einspielen', jira_key: 'ITPKK-123' })).body.task;
    assert.equal((await call('POST', '/api/timer', { work_date: day, start_time: '10:35', description: 'Updates einspielen', jira_key: 'ITPKK-123', task_id: 99999 })).status, 400);

    // Teil 1 aus der Aufgabe gestartet, mit Zuschlag gestoppt: Teil endet zur echten Zeit
    let r = await call('POST', '/api/timer', { work_date: day, start_time: '10:35', description: 'Updates einspielen', jira_key: 'ITPKK-123', task_id: task.id });
    assert.equal(r.body.timer.taskId, task.id);
    r = await call('POST', '/api/timer/stop', { end_time: '11:10', real_end_time: '11:05' });
    const part1 = r.body.entry;
    assert.deepEqual(part1.segments, [['10:35', '11:05']]);
    assert.equal(part1.taskId, task.id);

    // Weitermachen: Teil 2 wird mit Teil 1 zusammengeführt, beide Zeiträume bleiben erhalten
    r = await call('POST', '/api/timer', { work_date: day, start_time: '12:35', description: 'Updates einspielen', jira_key: 'ITPKK-123', resume_entry_id: part1.id, carry_minutes: 30 });
    assert.equal(r.body.timer.taskId, task.id, 'Aufgabe wandert mit');
    r = await call('POST', '/api/timer/stop', { end_time: '13:05', real_end_time: '13:05' });
    assert.deepEqual(r.body.entry.segments, [['10:35', '11:05'], ['12:35', '13:05']]);
    assert.equal(r.body.entry.durationMinutes, 60);

    // Nachtragen mit echten Uhrzeiten bzw. nur mit Dauer
    r = await call('POST', '/api/entries', { work_date: day, start_time: '08:00', end_time: '08:45', description: 'Monitoring', real_times: true });
    assert.deepEqual(r.body.entry.segments, [['08:00', '08:45']]);
    const timed = r.body.entry;
    r = await call('POST', '/api/entries', { work_date: day, start_time: '13:05', end_time: '13:35', description: 'Teammeeting' });
    assert.equal(r.body.entry.segments, null, 'nur Dauer: ohne Uhrzeit');

    // Bearbeiten: Dauer geändert -> einzelner Zeitraum wandert mit; echte Uhrzeiten -> neuer Zeitraum
    r = await call('PUT', `/api/entries/${timed.id}`, { work_date: day, start_time: '08:00', end_time: '09:00', description: 'Monitoring' });
    assert.deepEqual(r.body.entry.segments, [['08:00', '09:00']]);
    r = await call('PUT', `/api/entries/${timed.id}`, { work_date: day, start_time: '07:30', end_time: '08:15', description: 'Monitoring', real_times: true });
    assert.deepEqual(r.body.entry.segments, [['07:30', '08:15']]);

    // Erfasste Zeit an der Aufgabe
    const list = (await call('GET', '/api/tasks')).body.tasks;
    assert.deepEqual(list.find((t) => t.id === task.id).tracked, { minutes: 60, count: 1 });
  } finally {
    server.kill();
  }
});
