'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const { normalizeBaseUrl, createClient, JiraError, MY_ISSUES_JQL } = require('../src/lib/jira');
const { createRouter } = require('../src/routes/jira');

const fake = { encryptField: (s) => 'enc:' + Buffer.from(s).toString('base64'), decryptField: (s) => Buffer.from(s.slice(4), 'base64').toString() };

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('Adresse: nur Jira Cloud, Links werden zur Basisadresse, alles andere abgelehnt', () => {
  assert.equal(normalizeBaseUrl('https://Firma.atlassian.net/browse/IT-1'), 'https://firma.atlassian.net');
  assert.equal(normalizeBaseUrl('firma.atlassian.net'), 'https://firma.atlassian.net');
  for (const bad of ['', 'http://evil.example.com', 'https://atlassian.net.evil.com', 'https://evil.com/firma.atlassian.net', 'https://user@x.atlassian.net.evil.com']) {
    assert.throws(() => normalizeBaseUrl(bad), JiraError, bad);
  }
});

test('Client: Basic-Anmeldung, Abfragen, Zuordnung der Felder, Fehlermeldungen ohne Token', async () => {
  const calls = [];
  const responses = [
    jsonRes(200, { displayName: 'Philipp', accountId: 'abc' }),
    jsonRes(200, { key: 'IT-7', fields: { summary: 'Drucker streikt', status: { name: 'In Arbeit' }, priority: { name: 'High' }, duedate: '2026-12-01' } }),
    jsonRes(200, { issues: [{ key: 'IT-1', fields: { summary: 'A', status: { name: 'Offen' } } }, { key: 'IT-2', fields: {} }] }),
    jsonRes(401, {}), jsonRes(404, {}), jsonRes(429, {}), jsonRes(500, {}),
  ];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return responses.shift(); };
  const c = createClient({ baseUrl: 'https://firma.atlassian.net', email: 'a@b.de', token: 'GEHEIM-TOKEN', fetchImpl });

  assert.deepEqual(await c.myself(), { displayName: 'Philipp', accountId: 'abc' });
  assert.equal(calls[0].opts.headers.Authorization, 'Basic ' + Buffer.from('a@b.de:GEHEIM-TOKEN').toString('base64'));
  assert.equal(calls[0].opts.redirect, 'error');
  assert.deepEqual(await c.issue('it-7'), { key: 'IT-7', summary: 'Drucker streikt', status: 'In Arbeit', priority: 'High', dueDate: '2026-12-01', done: false });
  assert.match(calls[1].url, /\/rest\/api\/3\/issue\/IT-7\?fields=summary,status,priority,duedate$/);
  const list = await c.myIssues();
  assert.equal(list.length, 2);
  assert.equal(list[1].summary, '');
  assert.equal(calls[2].opts.method, 'POST');
  assert.match(calls[2].url, /\/rest\/api\/3\/search\/jql$/);
  assert.equal(JSON.parse(calls[2].opts.body).jql, MY_ISSUES_JQL);

  await assert.rejects(c.myself(), (e) => e.status === 401 && /E-Mail oder API-Token/.test(e.message) && !/GEHEIM/.test(e.message));
  await assert.rejects(c.issue('IT-1'), (e) => e.status === 404);
  await assert.rejects(c.myself(), (e) => e.status === 429);
  await assert.rejects(c.myself(), (e) => e.status === 502);
  await assert.rejects(c.issue('kein ticket'), (e) => e.status === 400);
});

test('Client: Netzfehler und Zeitüberschreitung werden verständlich gemeldet', async () => {
  const c1 = createClient({ baseUrl: 'https://f.atlassian.net', email: 'a@b.de', token: 't', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(c1.myself(), /nicht erreichbar/);
  const c2 = createClient({
    baseUrl: 'https://f.atlassian.net', email: 'a@b.de', token: 't', timeoutMs: 20,
    fetchImpl: (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))),
  });
  await assert.rejects(c2.myself(), /Zeitüberschreitung/);
});

async function withApp(fetchImpl, fn) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE jira_settings (user_id INTEGER PRIMARY KEY, config_enc TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  db.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, work_date TEXT, start_time TEXT, end_time TEXT,
    duration_minutes INTEGER, description_enc TEXT, jira_key TEXT, transferred_to_jira INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
    jira_comment_issue TEXT, jira_comment_id TEXT, updated_at TEXT, task_id INTEGER, school_day INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, title_enc TEXT, jira_key TEXT, status TEXT NOT NULL DEFAULT 'open',
    deleted_at TEXT, jira_status TEXT, jira_done_hint TEXT)`);
  db.exec("CREATE TABLE jira_seen (user_id INTEGER, key TEXT, seen_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (user_id, key))");
  db.exec("CREATE TABLE jira_ignored (user_id INTEGER, key TEXT, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (user_id, key))");
  db.exec('CREATE TABLE jira_daily_close (user_id INTEGER, work_date TEXT, key TEXT, status TEXT, updated_at TEXT, PRIMARY KEY (user_id, work_date))');
  const audits = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: Number(req.get('x-user') || 1) }; next(); });
  app.use('/api/jira', createRouter({ db, ...fake, audit: (...a) => audits.push(a), fetchImpl }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/jira`;
  const call = async (method, path, body, user) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': String(user) } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try { await fn({ call, db, audits }); } finally { server.close(); }
}

test('Einstellungen: prüfen, verschlüsselt speichern, Token nie ausgeben, Token bleibt beim Ändern, entfernen', async () => {
  await withApp(async () => jsonRes(200, {}), async ({ call, db, audits }) => {
    assert.deepEqual((await call('GET', '/settings')).body, { configured: false, baseUrl: '', email: '', hasToken: false, allowWrite: false, dailyProject: '', closeDaily: false, excludeProjects: '', jqlFilter: '', syncTasks: true, notifyNew: true });
    assert.equal((await call('PUT', '/settings', { baseUrl: 'https://evil.com', email: 'a@b.de', apiToken: 'x' })).status, 400);
    assert.equal((await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'keine-mail', apiToken: 'x' })).status, 400);
    assert.equal((await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de' })).status, 400, 'Token fehlt');

    let r = await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net/browse/X-1', email: 'a@b.de', apiToken: 'GEHEIM-123' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { configured: true, baseUrl: 'https://f.atlassian.net', email: 'a@b.de', hasToken: true, allowWrite: false, dailyProject: '', closeDaily: false, excludeProjects: '', jqlFilter: '', syncTasks: true, notifyNew: true });
    assert.doesNotMatch(JSON.stringify((await call('GET', '/settings')).body), /GEHEIM/);
    assert.doesNotMatch(db.prepare('SELECT config_enc FROM jira_settings').get().config_enc.replace(/^enc:/, ''), /GEHEIM/); // base64, nicht Klartext
    // E-Mail ändern ohne neuen Token: der alte bleibt
    r = await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'neu@b.de' });
    assert.equal(r.body.hasToken, true);
    assert.equal(JSON.parse(fake.decryptField(db.prepare('SELECT config_enc FROM jira_settings').get().config_enc)).token, 'GEHEIM-123');
    assert.equal(audits.length, 2);
    // andere Person sieht nichts
    assert.equal((await call('GET', '/settings', null, 2)).body.configured, false);
    assert.equal((await call('DELETE', '/settings')).body.configured, false);
  });
});

test('Abfragen: ohne Einrichtung 409, Jira-Fehler werden nie als 401/403 weitergegeben', async () => {
  let next = jsonRes(200, { displayName: 'P' });
  await withApp(async () => next, async ({ call }) => {
    assert.equal((await call('GET', '/my-issues')).status, 409);
    await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', apiToken: 't' });
    assert.deepEqual((await call('POST', '/test')).body, { ok: true, displayName: 'P' });
    next = jsonRes(401, {});
    let r = await call('POST', '/test');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /E-Mail oder API-Token/);
    next = jsonRes(403, {});
    assert.equal((await call('GET', '/issue/IT-1')).status, 400);
    next = jsonRes(404, {});
    assert.equal((await call('GET', '/issue/IT-1')).status, 404);
    next = jsonRes(200, { issues: [{ key: 'IT-1', fields: { summary: 'S', status: { name: 'Offen' } } }] });
    r = await call('GET', '/my-issues');
    assert.equal(r.body.issues[0].summary, 'S');
    assert.equal((await call('GET', '/issue/%20')).status, 400);
  });
});

test('Kommentare nach Jira: nur nach Einschalten, eigenes Ticket bzw. Tagesticket, Aktualisieren statt doppelt, intern', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.endsWith('/search/jql')) return jsonRes(200, { issues: [{ key: 'PITPM-33', fields: { summary: '2026-11-19 (Nachtrag)' } }, { key: 'PITPM-34', fields: { summary: '2026-11-20' } }] });
    if (opts.method === 'POST' && /\/comment$/.test(url)) return jsonRes(201, { id: String(100 + calls.length) });
    if (opts.method === 'PUT') return jsonRes(200, {});
    if (opts.method === 'DELETE') return { ok: true, status: 204, json: async () => { throw new Error('leer'); } };
    return jsonRes(404, {});
  };
  await withApp(fetchImpl, async ({ call, db, audits }) => {
    const ins = db.prepare('INSERT INTO entries (user_id, work_date, start_time, end_time, duration_minutes, description_enc, jira_key) VALUES (1,?,?,?,?,?,?)');
    const a = ins.run('2026-11-20', '08:00', '08:45', 45, fake.encryptField('Netzwerkdoku ergänzt'), 'ITPKK-210').lastInsertRowid;
    const b = ins.run('2026-11-20', '08:45', '09:15', 30, fake.encryptField('Teammeeting'), null).lastInsertRowid;
    const other = db.prepare('INSERT INTO entries (user_id, work_date, start_time, end_time, duration_minutes, description_enc) VALUES (2,?,?,?,?,?)').run('2026-11-20', '08:00', '09:00', 60, fake.encryptField('fremd')).lastInsertRowid;

    await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', apiToken: 't' });
    let r = await call('POST', '/comments', { ids: [a] });
    assert.equal(r.status, 409, 'Schreiben erst nach Einschalten');
    assert.match(r.body.error, /ausgeschaltet/);
    assert.equal((await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', dailyProject: 'pit pm' })).status, 400);
    r = await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', allowWrite: true, dailyProject: 'pitpm' });
    assert.equal(r.body.dailyProject, 'PITPM');
    assert.equal(r.body.allowWrite, true);

    r = await call('POST', '/comments', { ids: [a, b, other] });
    assert.deepEqual(r.body.results.map((x) => [x.ok, x.key || x.error]), [[true, 'ITPKK-210'], [true, 'PITPM-34'], [false, 'Eintrag nicht gefunden.']]);
    const posts = calls.filter((c) => c.method === 'POST' && /\/comment$/.test(c.url));
    assert.equal(posts.length, 2);
    assert.match(posts[0].url, /\/issue\/ITPKK-210\/comment$/);
    assert.equal(posts[0].body.body.content[0].content[0].text, '45 Min – Netzwerkdoku ergänzt');
    assert.deepEqual(posts[0].body.properties, [{ key: 'sd.public.comment', value: { internal: true } }]);
    const search = calls.find((c) => c.url.endsWith('/search/jql'));
    assert.match(search.body.jql, /project = "PITPM" AND summary ~ "\\"2026-11-20\\""/);
    const rowA = db.prepare('SELECT * FROM entries WHERE id = ?').get(a);
    assert.equal(rowA.transferred_to_jira, 1);
    assert.equal(rowA.jira_comment_issue, 'ITPKK-210');
    assert.ok(audits.some((x) => x[1] === 'jira_comments_written'));

    // Nochmals schreiben: derselbe Kommentar wird aktualisiert, nicht doppelt angelegt
    calls.length = 0;
    r = await call('POST', '/comments', { ids: [a] });
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);

    // Ohne Projekt für Tagestickets: Eintrag ohne Ticket mit klarer Meldung
    await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', dailyProject: '' });
    const c2 = ins.run('2026-11-20', '09:15', '09:30', 15, fake.encryptField('Ohne'), null).lastInsertRowid;
    r = await call('POST', '/comments', { ids: [c2] });
    assert.match(r.body.results[0].error, /Tagestickets/);
  });
});

test('Kommentare: Bearbeiten passt an (auch Wechsel des Tickets), Löschen entfernt den Kommentar', async () => {
  const { createJiraComments } = require('../src/lib/jiraComments');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE jira_settings (user_id INTEGER PRIMARY KEY, config_enc TEXT NOT NULL);
    CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, work_date TEXT, start_time TEXT, end_time TEXT,
    duration_minutes INTEGER, description_enc TEXT, jira_key TEXT, transferred_to_jira INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
    jira_comment_issue TEXT, jira_comment_id TEXT, updated_at TEXT, task_id INTEGER);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, user_id INTEGER, title_enc TEXT, jira_key TEXT)`);
  db.prepare('INSERT INTO jira_settings VALUES (1, ?)').run(fake.encryptField(JSON.stringify({ baseUrl: 'https://f.atlassian.net', email: 'a@b.de', token: 't', allowWrite: true })));
  const calls = [];
  let nextStatus = 200;
  const fetchImpl = async (url, opts) => {
    calls.push(`${opts.method} ${url.replace('https://f.atlassian.net/rest/api/3', '')}`);
    if (nextStatus !== 200) { const s = nextStatus; nextStatus = 200; return jsonRes(s, {}); }
    if (opts.method === 'POST') return jsonRes(201, { id: '555' });
    if (opts.method === 'DELETE') return { ok: true, status: 204, json: async () => null };
    return jsonRes(200, {});
  };
  const c = createJiraComments({ db, decryptField: fake.decryptField, fetchImpl });
  const id = db.prepare("INSERT INTO entries (user_id, work_date, start_time, end_time, duration_minutes, description_enc, jira_key, jira_comment_issue, jira_comment_id, transferred_to_jira) VALUES (1,'2026-11-20','08:00','08:45',45,?,'IT-1','IT-1','42',1)").run(fake.encryptField('A')).lastInsertRowid;

  assert.deepEqual(await c.afterEdit(1, id), { ok: true });
  assert.deepEqual(calls, ['PUT /issue/IT-1/comment/42']);
  db.prepare("UPDATE entries SET jira_key = 'IT-2' WHERE id = ?").run(id);
  calls.length = 0;
  await c.afterEdit(1, id);
  assert.deepEqual(calls, ['DELETE /issue/IT-1/comment/42', 'POST /issue/IT-2/comment']);
  assert.equal(db.prepare('SELECT jira_comment_id FROM entries WHERE id = ?').get(id).jira_comment_id, '555');
  // in Jira schon gelöscht: neu anlegen statt Fehler
  calls.length = 0; nextStatus = 404;
  await c.afterEdit(1, id);
  assert.deepEqual(calls, ['PUT /issue/IT-2/comment/555', 'POST /issue/IT-2/comment']);

  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  calls.length = 0;
  assert.deepEqual(await c.beforeDelete(1, row), { ok: true });
  assert.deepEqual(calls, ['DELETE /issue/IT-2/comment/555']);
  const after = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  assert.equal(after.jira_comment_id, null);
  assert.equal(after.transferred_to_jira, 0);
  // Eintrag ohne Kommentar: nichts zu tun
  assert.equal(await c.afterEdit(1, id), null);
  assert.equal(c.commentText({ description_enc: fake.encryptField(''), duration_minutes: 30 }), '30 Min');
  assert.equal(c.commentText({ description_enc: fake.encryptField('X'), duration_minutes: 30, start_time: '08:00', end_time: '08:30' }, true), '08:00–08:30 (30 Min) – X');
});

test('Abgleich: erledigte Tickets schlagen Abhaken vor (einmal), neue Tickets erst ab dem zweiten Lauf', async () => {
  const state = { done: new Set(), mine: ['IT-1', 'IT-2'], searches: [] };
  const issue = (key) => ({ key, fields: { summary: `Titel ${key}`, status: { name: state.done.has(key) ? 'Fertig' : 'In Arbeit', statusCategory: { key: state.done.has(key) ? 'done' : 'indeterminate' } } } });
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (/search\/jql$/.test(url) && /^key in/.test(body.jql)) {
      state.searches.push(body.jql);
      const keys = body.jql.slice(8, -1).split(',');
      if (keys.includes('GONE-1')) return jsonRes(400, { errorMessages: ['An issue with key GONE-1 does not exist'] });
      return jsonRes(200, { issues: keys.map(issue) });
    }
    if (/search\/jql$/.test(url)) return jsonRes(200, { issues: state.mine.map(issue) });
    const m = /issue\/([A-Z]+-\d+)\?/.exec(url);
    if (m) return m[1] === 'GONE-1' ? jsonRes(404, {}) : jsonRes(200, issue(m[1]));
    return jsonRes(404, {});
  };
  await withApp(fetchImpl, async ({ call, db }) => {
    assert.deepEqual((await call('POST', '/sync')).body, { configured: false });
    await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', apiToken: 't' });
    const add = (title, key) => db.prepare('INSERT INTO tasks (user_id, title_enc, jira_key) VALUES (1, ?, ?)').run(fake.encryptField(title), key).lastInsertRowid;
    const t1 = add('Drucker', 'IT-1');
    add('Ohne Ticket', null);

    // erster Lauf: nichts erledigt, der Stand der eigenen Tickets wird nur gemerkt
    let r = (await call('POST', '/sync', { force: true })).body;
    assert.deepEqual(r, { doneTasks: [], newIssues: [] });
    assert.equal(db.prepare('SELECT jira_status FROM tasks WHERE id = ?').get(t1).jira_status, 'In Arbeit');
    assert.deepEqual((await call('POST', '/sync')).body, { skipped: true }, 'höchstens alle 5 Minuten');

    // Ticket erledigt, neues Ticket zugewiesen
    state.done.add('IT-1');
    state.mine = ['IT-2', 'IT-3'];
    r = (await call('POST', '/sync', { force: true })).body;
    assert.deepEqual(r.doneTasks, [{ id: t1, title: 'Drucker', key: 'IT-1', status: 'Fertig' }]);
    assert.deepEqual(r.newIssues, [{ key: 'IT-3', summary: 'Titel IT-3' }]);
    assert.equal(db.prepare('SELECT jira_done_hint FROM tasks WHERE id = ?').get(t1).jira_done_hint, 'new');
    // nicht doppelt
    r = (await call('POST', '/sync', { force: true })).body;
    assert.deepEqual(r, { doneTasks: [], newIssues: [] });
    // Ticket wieder geöffnet: Hinweis weg
    state.done.delete('IT-1');
    await call('POST', '/sync', { force: true });
    assert.equal(db.prepare('SELECT jira_done_hint FROM tasks WHERE id = ?').get(t1).jira_done_hint, null);

    // unbekanntes Ticket: die Suche scheitert, dann wird einzeln gefragt
    add('Weg', 'GONE-1');
    state.done.add('IT-1');
    r = (await call('POST', '/sync', { force: true })).body;
    assert.equal(r.doneTasks.length, 1);

    // abgeschaltet
    await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', syncTasks: false, notifyNew: false });
    assert.deepEqual((await call('GET', '/settings')).body.syncTasks, false);
    assert.deepEqual((await call('POST', '/sync', { force: true })).body, { doneTasks: [], newIssues: [] });
  });
});

test('Abgleich: Benachrichtigungstexte', () => {
  const { createJiraSync } = require('../src/lib/jiraSync');
  const s = createJiraSync({ db: new Database(':memory:').exec('CREATE TABLE tasks (id INTEGER, user_id INTEGER, title_enc TEXT, jira_key TEXT, status TEXT, deleted_at TEXT, jira_status TEXT, jira_done_hint TEXT); CREATE TABLE jira_seen (user_id INTEGER, key TEXT); CREATE TABLE jira_ignored (user_id INTEGER, key TEXT); CREATE TABLE jira_settings (user_id INTEGER, config_enc TEXT)'), decryptField: (v) => v });
  assert.deepEqual(s.messages({ doneTasks: [{ key: 'IT-1', title: 'Drucker' }], newIssues: [] }), [{ title: 'Ticket in Jira erledigt', body: 'IT-1 „Drucker“ – Aufgabe abhaken?' }]);
  assert.equal(s.messages({ doneTasks: [], newIssues: [{ key: 'IT-3', summary: 'A' }, { key: 'IT-4', summary: 'B' }] })[0].title, '2 neue Jira-Tickets für dich');
  assert.deepEqual(s.messages({ skipped: true }), []);
});

test('Kommentare: Eintrag ohne Ticket mit Aufgabe geht ins Ticket der Aufgabe; Vorschau zeigt Ziel, Titel und Text', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method, body });
    if (url.endsWith('/search/jql') && /^key in/.test(body.jql)) {
      return jsonRes(200, { issues: [{ key: 'ITSUP-5', fields: { summary: 'Drucker 2. OG', status: { name: 'Offen' } } }, { key: 'PITPM-40', fields: { summary: '2026-11-23' } }] });
    }
    if (url.endsWith('/search/jql')) return jsonRes(200, { issues: [{ key: 'PITPM-40', fields: { summary: '2026-11-23' } }] });
    if (opts.method === 'POST' && /\/comment$/.test(url)) return jsonRes(201, { id: String(500 + calls.length) });
    return jsonRes(404, {});
  };
  await withApp(fetchImpl, async ({ call, db }) => {
    await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', apiToken: 't', allowWrite: true, dailyProject: 'PITPM' });
    const task = db.prepare('INSERT INTO tasks (user_id, title_enc, jira_key) VALUES (1, ?, ?)').run(fake.encryptField('Drucker'), 'ITSUP-5').lastInsertRowid;
    const ins = db.prepare('INSERT INTO entries (user_id, work_date, start_time, end_time, duration_minutes, description_enc, jira_key, task_id) VALUES (1,?,?,?,?,?,?,?)');
    const fromTask = ins.run('2026-11-23', '08:00', '08:30', 30, fake.encryptField('Toner getauscht'), null, task).lastInsertRowid;
    const plain = ins.run('2026-11-23', '08:30', '09:00', 30, fake.encryptField('Teammeeting'), null, null).lastInsertRowid;

    const before = calls.length;
    const { items } = (await call('POST', '/comments/preview', { ids: [fromTask, plain] })).body;
    assert.equal(calls.slice(before).filter((c) => c.method === 'POST' && /\/comment$/.test(c.url)).length, 0, 'Vorschau schreibt nichts');
    assert.deepEqual(items.map((i) => [i.key, i.source, i.summary, i.text, i.action]), [
      ['ITSUP-5', 'aufgabe', 'Drucker 2. OG', '30 Min – Toner getauscht', 'neu'],
      ['PITPM-40', 'tagesticket', '2026-11-23', '30 Min – Teammeeting', 'neu'],
    ]);
    assert.equal(items[0].taskTitle, 'Drucker');

    const r = await call('POST', '/comments', { ids: [fromTask, plain] });
    assert.deepEqual(r.body.results.map((x) => [x.key, x.source, x.daily]), [['ITSUP-5', 'aufgabe', false], ['PITPM-40', 'tagesticket', true]]);
    // danach: Vorschau meldet "aktualisieren"
    const again = (await call('POST', '/comments/preview', { ids: [fromTask] })).body.items[0];
    assert.equal(again.action, 'aktualisieren');
  });
});

test('Meine Tickets: Projekte ausschließen, eigener Filter, Tagestickets nie, Ausblenden und wieder Einblenden', async () => {
  const searches = [];
  const issue = (key, summary) => ({ key, fields: { summary, status: { name: 'Offen', statusCategory: { key: 'new' } } } });
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (/search\/jql$/.test(url)) {
      searches.push(body.jql);
      if (/kaputt/.test(body.jql)) return jsonRes(400, { errorMessages: ["Das Feld 'kaputt' gibt es nicht."] });
      return jsonRes(200, { issues: [issue('ITPKK-1', 'Drucker'), issue('PITPM-40', '2026-11-23'), issue('PITPM-41', 'Projektplanung'), issue('ITPKK-2', 'Monitor')] });
    }
    return jsonRes(404, {});
  };
  await withApp(fetchImpl, async ({ call }) => {
    await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', apiToken: 't', dailyProject: 'PITPM' });
    let r = (await call('GET', '/my-issues')).body;
    assert.deepEqual(r.issues.map((i) => i.key), ['ITPKK-1', 'PITPM-41', 'ITPKK-2'], 'Tagesticket (Titel = Datum) fällt heraus');

    // Einstellungen: ungültige Projekte, mehrzeiliger Filter, ORDER BY werden abgelehnt
    assert.equal((await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', excludeProjects: 'hr, 1x' })).status, 400);
    assert.equal((await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', jqlFilter: 'a = 1\nb = 2' })).status, 400);
    assert.equal((await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', jqlFilter: 'priority = High ORDER BY key' })).status, 400);
    const st = (await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', excludeProjects: 'hr; pitpm,HR', jqlFilter: 'priority in (High, Highest)' })).body;
    assert.equal(st.excludeProjects, 'HR, PITPM');
    await call('GET', '/my-issues');
    assert.equal(searches.at(-1), 'assignee = currentUser() AND statusCategory != Done AND project NOT IN ("HR", "PITPM") AND (priority in (High, Highest)) ORDER BY updated DESC');

    // Ausblenden: verschwindet aus den Vorschlägen, steht unter "ignored"
    assert.equal((await call('POST', '/ignore', { key: 'itpkk-2' })).body.key, 'ITPKK-2');
    r = (await call('GET', '/my-issues')).body;
    assert.ok(!r.issues.some((i) => i.key === 'ITPKK-2'));
    assert.deepEqual(r.ignored.map((i) => i.key), ['ITPKK-2']);
    await call('POST', '/ignore', { key: 'ITPKK-2', ignored: false });
    assert.ok((await call('GET', '/my-issues')).body.issues.some((i) => i.key === 'ITPKK-2'));
    assert.equal((await call('POST', '/ignore', { key: 'kein ticket' })).status, 400);

    // Fehler im eigenen Filter: Jiras Begründung kommt an
    await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de', jqlFilter: 'kaputt = 1' });
    const bad = await call('GET', '/my-issues');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Das Feld 'kaputt' gibt es nicht/);
  });
});
