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
  assert.deepEqual(await c.issue('it-7'), { key: 'IT-7', summary: 'Drucker streikt', status: 'In Arbeit', priority: 'High', dueDate: '2026-12-01' });
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
    assert.deepEqual((await call('GET', '/settings')).body, { configured: false, baseUrl: '', email: '', hasToken: false });
    assert.equal((await call('PUT', '/settings', { baseUrl: 'https://evil.com', email: 'a@b.de', apiToken: 'x' })).status, 400);
    assert.equal((await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'keine-mail', apiToken: 'x' })).status, 400);
    assert.equal((await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net', email: 'a@b.de' })).status, 400, 'Token fehlt');

    let r = await call('PUT', '/settings', { baseUrl: 'https://f.atlassian.net/browse/X-1', email: 'a@b.de', apiToken: 'GEHEIM-123' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { configured: true, baseUrl: 'https://f.atlassian.net', email: 'a@b.de', hasToken: true });
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
