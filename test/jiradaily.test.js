'use strict';

// Tagestickets abschließen (nur nach Bestätigung): wann gefragt wird und wie in Jira auf "Fertig" gesetzt wird.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createJiraDaily } = require('../src/lib/jiraDaily');
const { createClient } = require('../src/lib/jira');

const fake = { encryptField: (s) => 'enc:' + Buffer.from(s).toString('base64'), decryptField: (s) => Buffer.from(s.slice(4), 'base64').toString() };
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function setup({ closeDaily = true, fetchImpl = async () => jsonRes(404, {}) } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE jira_settings (user_id INTEGER PRIMARY KEY, config_enc TEXT NOT NULL);
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, work_date TEXT, duration_minutes INTEGER,
      transferred_to_jira INTEGER NOT NULL DEFAULT 0, school_day INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, jira_comment_issue TEXT);
    CREATE TABLE jira_daily_close (user_id INTEGER, work_date TEXT, key TEXT, status TEXT, updated_at TEXT, PRIMARY KEY (user_id, work_date))`);
  db.prepare('INSERT INTO jira_settings VALUES (1, ?)').run(fake.encryptField(JSON.stringify({
    baseUrl: 'https://f.atlassian.net', email: 'a@b.de', token: 't', allowWrite: true, dailyProject: 'PITPM', closeDaily,
  })));
  const add = (date, min, { tr = 1, school = 0, issue = null } = {}) => db.prepare(
    'INSERT INTO entries (user_id, work_date, duration_minutes, transferred_to_jira, school_day, jira_comment_issue) VALUES (1, ?, ?, ?, ?, ?)'
  ).run(date, min, tr, school, issue);
  const daily = createJiraDaily({ db, decryptField: fake.decryptField, fetchImpl, endTimeFor: () => '16:30' });
  return { db, add, daily };
}
const at = (s) => new Date(s);

test('Vorschlag: erst wenn alles in Jira steht und Feierabend ist; Berufsschule zählt nicht; nur mit Tagesticket', () => {
  const { add, daily, db } = setup();
  add('2026-11-24', 45, { issue: 'PITPM-40' });
  add('2026-11-24', 30, { issue: 'ITPKK-210' });
  add('2026-11-24', 360, { tr: 0, school: 1 }); // Berufsschule, nicht in Jira: zählt nicht
  assert.deepEqual(daily.pending(1, at('2026-11-24T15:00:00')), [], 'vor Feierabend nicht');
  assert.deepEqual(daily.pending(1, at('2026-11-24T16:45:00')).map((p) => [p.date, p.key, p.count, p.minutes]), [['2026-11-24', 'PITPM-40', 3, 435]]);

  add('2026-11-24', 15, { tr: 0 }); // noch offen
  assert.deepEqual(daily.pending(1, at('2026-11-24T17:00:00')), [], 'offener Eintrag verhindert den Vorschlag');

  add('2026-11-23', 60, { issue: 'ITPKK-1' }); // Tag ohne Tagesticket
  assert.ok(!daily.pending(1, at('2026-11-25T09:00:00')).some((p) => p.date === '2026-11-23'));

  add('2026-11-20', 60, { issue: 'PITPM-34' }); // Vortag: auch morgens
  assert.ok(daily.pending(1, at('2026-11-24T08:00:00')).some((p) => p.date === '2026-11-20'));
  assert.ok(daily.dismiss(1, '2026-11-20'));
  assert.ok(!daily.pending(1, at('2026-11-24T08:00:00')).some((p) => p.date === '2026-11-20'), '"Nicht abschließen" gilt');
  assert.equal(db.prepare("SELECT status FROM jira_daily_close WHERE work_date = '2026-11-20'").get().status, 'dismissed');

  const off = setup({ closeDaily: false });
  off.add('2026-11-24', 45, { issue: 'PITPM-40' });
  assert.deepEqual(off.daily.pending(1, at('2026-11-24T18:00:00')), [], 'ausgeschaltet: nie');
});

test('Benachrichtigung: einmal je Tag; Bestätigung bleibt nötig', () => {
  const { add, daily } = setup();
  add('2026-11-24', 45, { issue: 'PITPM-40' });
  const msgs = [];
  daily.notifyAll({ notify: (m) => msgs.push(m), now: at('2026-11-24T16:40:00') });
  daily.notifyAll({ notify: (m) => msgs.push(m), now: at('2026-11-24T16:50:00') });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].title, 'Tagesticket PITPM-40 abschließen?');
  assert.match(msgs[0].body, /24\.11\..*Bestätigen/);
  assert.equal(daily.pending(1, at('2026-11-24T17:00:00')).length, 1, 'nach der Meldung weiter offen');
});

test('Abschließen: Übergang nach "Fertig", Pflichtfeld Lösung wird gefüllt, Ergebnis wird gemerkt', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (/\/transitions\?/.test(url)) {
      return jsonRes(200, { transitions: [
        { id: '11', name: 'In Arbeit', to: { name: 'In Arbeit', statusCategory: { key: 'indeterminate' } } },
        { id: '31', name: 'Fertig', to: { name: 'Fertig', statusCategory: { key: 'done' } },
          fields: { resolution: { required: true, name: 'Lösung', allowedValues: [{ id: '5', name: 'Nicht umgesetzt' }, { id: '1', name: 'Fertig' }] } } },
      ] });
    }
    if (/\/transitions$/.test(url)) return { ok: true, status: 204, json: async () => null };
    if (/\/issue\/PITPM-40\?/.test(url)) return jsonRes(200, { key: 'PITPM-40', fields: { summary: '2026-11-24', status: { name: 'Offen', statusCategory: { key: 'new' } } } });
    return jsonRes(404, {});
  };
  const { add, daily, db } = setup({ fetchImpl });
  add('2026-11-24', 45, { issue: 'PITPM-40' });
  await assert.rejects(daily.close(1, '2026-11-23'), /kein Tagesticket/);
  const r = await daily.close(1, '2026-11-24');
  assert.deepEqual(r, { key: 'PITPM-40', status: 'Fertig', already: false });
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, { transition: { id: '31' }, fields: { resolution: { id: '1' } } });
  assert.equal(db.prepare("SELECT status FROM jira_daily_close WHERE work_date = '2026-11-24'").get().status, 'closed');
  assert.deepEqual(daily.pending(1, at('2026-11-24T18:00:00')), [], 'danach nicht mehr vorgeschlagen');
});

test('Jira-Client closeIssue: schon fertig, anderes Pflichtfeld, kein Weg nach "Fertig"', async () => {
  const make = (issueStatus, transitions) => createClient({
    baseUrl: 'https://f.atlassian.net', email: 'a@b.de', token: 't',
    fetchImpl: async (url, opts) => {
      if (/\/transitions\?/.test(url)) return jsonRes(200, { transitions });
      if (opts.method === 'POST') throw new Error('darf nicht schreiben');
      return jsonRes(200, { key: 'PITPM-1', fields: { summary: 'x', status: issueStatus } });
    },
  });
  const done = { name: 'Fertig', statusCategory: { key: 'done' } };
  const open = { name: 'Offen', statusCategory: { key: 'new' } };
  assert.deepEqual(await make(done, []).closeIssue('PITPM-1'), { key: 'PITPM-1', status: 'Fertig', already: true });
  await assert.rejects(make(open, [{ id: '2', to: done, fields: { customfield_1: { required: true, name: 'Aufwand' } } }]).closeIssue('PITPM-1'), /verlangt.*Aufwand/);
  await assert.rejects(make(open, [{ id: '3', to: { name: 'In Arbeit', statusCategory: { key: 'indeterminate' } } }]).closeIssue('PITPM-1'), /nicht auf „Fertig“ setzen \(möglich: In Arbeit\)/);
});
