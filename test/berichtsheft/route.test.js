'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const { createRouter } = require('../../src/routes/berichtsheft');

const fake = { encryptField: (s) => 'enc:' + Buffer.from(s).toString('base64'), decryptField: (s) => Buffer.from(s.slice(4), 'base64').toString() };

const GOOD = JSON.stringify({
  zuordnung: [{ id: 1, block: 'betrieb' }, { id: 2, block: 'schule' }],
  betrieb: 'Es wurde ein Backup für ein Kunde geprüft.',
  schule: 'Im Unterricht wurde Subnetting behandelt.',
});

async function withApp({ env = {}, localMode = true, generate } = {}, fn) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY, user_id INTEGER, work_date TEXT, start_time TEXT, end_time TEXT, duration_minutes INTEGER, description_enc TEXT, jira_key TEXT, deleted_at TEXT, school_day INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE berichtsheft_settings (user_id INTEGER PRIMARY KEY, config_enc TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  const ins = db.prepare('INSERT INTO entries (user_id, work_date, start_time, end_time, duration_minutes, description_enc, jira_key, school_day) VALUES (1, ?, ?, ?, 60, ?, ?, ?)');
  ins.run('2026-10-19', '08:00', '09:00', fake.encryptField('Backup geprüft für Acme'), 'ITPKK-1', 0);
  ins.run('2026-10-21', '08:00', '09:00', fake.encryptField('Subnetting'), null, 1);
  ins.run('2026-11-30', '08:00', '09:00', fake.encryptField('außerhalb'), null, 0);
  const calls = { generate: [], models: [] };
  const providers = {
    generate: generate || (async (o) => { calls.generate.push(o); return GOOD; }),
    listModels: async (o) => { calls.models.push(o); return ['m-a', 'm-b']; },
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1 }; next(); });
  const audits = [];
  app.use('/api/berichtsheft', createRouter({ db, ...fake, localMode, env, providers, audit: (...a) => audits.push(a) }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/berichtsheft`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try { await fn({ call, calls, audits, db }); } finally { server.close(); }
}

const WEEK = { from: '2026-10-19', to: '2026-10-25' };

test('Einstellungen: Schlüssel werden nie ausgegeben, Änderungen geprüft', async () => {
  await withApp({}, async ({ call }) => {
    let r = await call('GET', '/settings');
    assert.equal(r.status, 200);
    assert.equal(r.body.provider, 'anthropic');
    assert.ok(r.body.providers.every((p) => p.hasKey === false));

    r = await call('PUT', '/settings', { provider: 'openai', model: 'gpt-x', apiKey: 'sk-geheim-123456' });
    assert.equal(r.status, 200);
    assert.doesNotMatch(JSON.stringify(r.body), /sk-geheim/);
    const openai = r.body.providers.find((p) => p.id === 'openai');
    assert.equal(openai.hasKey, true);
    assert.equal(openai.model, 'gpt-x');

    assert.equal((await call('PUT', '/settings', { provider: 'quatsch' })).status, 400);
    assert.equal((await call('PUT', '/settings', { apiKey: 'zu kurz' })).status, 400);
    assert.equal((await call('PUT', '/settings', { names: [{ term: 'X', kind: 'katze' }] })).status, 400);

    r = await call('PUT', '/settings', { names: [{ term: 'Acme', kind: 'kunde' }, { term: 'acme', kind: 'firma' }], keywords: ['Schule', ' '], allow: ['Lini'] });
    assert.deepEqual(r.body.names, [{ term: 'Acme', kind: 'kunde' }]);
    assert.deepEqual(r.body.keywords, ['Schule']);

    r = await call('PUT', '/settings', { clearKey: true });
    assert.equal(r.body.providers.find((p) => p.id === 'openai').hasKey, false);
  });
});

test('Serverbetrieb: eigene Adresse gesperrt, KI abschaltbar', async () => {
  await withApp({ localMode: false }, async ({ call }) => {
    const s = await call('GET', '/settings');
    assert.ok(!s.body.providers.some((p) => p.id === 'kompatibel'));
    assert.equal((await call('PUT', '/settings', { provider: 'kompatibel' })).status, 403);
    assert.equal((await call('PUT', '/settings', { provider: 'openai', baseUrl: 'http://intern:8080' })).status, 400);
  });
  await withApp({ localMode: false, env: { BERICHTSHEFT_ALLOW_CUSTOM_URL: 'true' } }, async ({ call }) => {
    const r = await call('PUT', '/settings', { provider: 'kompatibel', baseUrl: 'http://localhost:11434/v1', model: 'llama' });
    assert.equal(r.status, 200);
    assert.equal(r.body.providers.find((p) => p.id === 'kompatibel').baseUrl, 'http://localhost:11434/v1');
  });
  await withApp({ env: { BERICHTSHEFT_KI: 'aus' } }, async ({ call }) => {
    await call('PUT', '/settings', { apiKey: 'sk-ant-123456789' });
    const p = await call('POST', '/prepare', WEEK);
    assert.equal(p.body.ai.usable, false);
    assert.equal((await call('POST', '/models', {})).status, 403);
  });
});

test('Vorschau, Klärung unbekannter Wörter, Erzeugen mit Pruefsumme', async () => {
  await withApp({}, async ({ call, calls, audits }) => {
    await call('PUT', '/settings', { apiKey: 'sk-ant-123456789', names: [{ term: 'Acme', kind: 'kunde' }] });
    let p = await call('POST', '/prepare', WEEK);
    assert.equal(p.status, 200);
    assert.equal(p.body.entryCount, 2);
    assert.deepEqual(p.body.items.map((i) => i.text), ['Backup geprüft für ein Kunde', 'Subnetting']);
    assert.equal(p.body.items[1].school, true);
    assert.deepEqual(p.body.replaced, [{ from: 'Acme', kind: 'kunde', count: 1 }]);
    assert.equal(p.body.ai.usable, true);
    assert.doesNotMatch(JSON.stringify(p.body), /ITPKK|Acme.*Backup/);
    // unbekannte Woerter: "Backup" und "Subnetting" sind bekannte IT-Begriffe, nichts offen
    assert.deepEqual(p.body.pending, []);

    // ohne Pruefsumme / mit falscher Pruefsumme
    assert.equal((await call('POST', '/generate', { ...WEEK, mode: 'ki' })).status, 409);
    assert.equal((await call('POST', '/generate', { ...WEEK, mode: 'ki', hash: 'falsch' })).body.stale, true);
    assert.equal((await call('POST', '/generate', { ...WEEK, mode: 'x', hash: p.body.hash })).status, 400);

    const g = await call('POST', '/generate', { ...WEEK, mode: 'ki', hash: p.body.hash });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.match(g.body.text, /^Betriebliche Tätigkeiten:\nEs wurde ein Backup/);
    assert.equal(g.body.schule, 'Im Unterricht wurde Subnetting behandelt.');
    assert.deepEqual(g.body.assignment.map((a) => a.block), ['betrieb', 'schule']);
    assert.equal(calls.generate.length, 1);
    assert.doesNotMatch(calls.generate[0].user + calls.generate[0].system, /Acme|ITPKK|2026/);
    assert.equal(audits.at(-1)[1], 'berichtsheft_generated');

    // lokal: kein Aufruf
    const l = await call('POST', '/generate', { ...WEEK, mode: 'lokal', hash: p.body.hash });
    assert.equal(l.status, 200);
    assert.equal(l.body.mode, 'lokal');
    assert.equal(calls.generate.length, 1);
  });
});

test('ungeklärte Wörter blockieren das Erzeugen, /review nimmt Entscheidungen auf', async () => {
  await withApp({}, async ({ call, calls, db }) => {
    db.prepare('INSERT INTO entries (user_id, work_date, start_time, end_time, duration_minutes, description_enc, jira_key) VALUES (1, ?, ?, ?, 60, ?, NULL)')
      .run('2026-10-22', '08:00', '09:00', fake.encryptField('Termin bei Herrn Müller wegen Zeppelin'));
    await call('PUT', '/settings', { apiKey: 'sk-ant-123456789', names: [{ term: 'Acme', kind: 'kunde' }] });
    let p = await call('POST', '/prepare', WEEK);
    const words = p.body.pending.map((x) => x.word);
    assert.ok(words.includes('Müller') && words.includes('Zeppelin'), words.join(','));
    assert.equal(p.body.pending.find((x) => x.word === 'Müller').strong, true);

    const blocked = await call('POST', '/generate', { ...WEEK, mode: 'ki', hash: p.body.hash });
    assert.equal(blocked.status, 409);
    assert.ok(blocked.body.pending.length >= 2);
    assert.equal(calls.generate.length, 0);

    const r = await call('POST', '/review', { ...WEEK, decisions: [{ word: 'Müller', kind: 'person' }, { word: 'Zeppelin', kind: 'firma' }, ...p.body.pending.filter((x) => !['Müller', 'Zeppelin'].includes(x.word)).map((x) => ({ word: x.word, kind: 'harmlos' }))] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.pending, []);
    assert.ok(r.body.items.some((i) => /ein Kollege/.test(i.text) && /ein Unternehmen/.test(i.text)));
    const g = await call('POST', '/generate', { ...WEEK, mode: 'ki', hash: r.body.hash });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.doesNotMatch(calls.generate[0].user, /Müller|Zeppelin/);

    assert.equal((await call('POST', '/review', { ...WEEK, decisions: [{ word: 'x', kind: 'komisch' }] })).status, 400);
    const added = await call('POST', '/review', { ...WEEK, names: [{ term: 'Backup', kind: 'kunde' }] });
    assert.ok(added.body.items[0].text.startsWith('ein Kunde'));
  });
});

test('fehlender Schlüssel, Zeitraum ohne Einträge, ungültiges Datum, Anbieterfehler', async () => {
  await withApp({}, async ({ call }) => {
    await call('PUT', '/settings', { names: [{ term: 'Acme', kind: 'kunde' }] });
    const p = await call('POST', '/prepare', WEEK);
    assert.equal(p.body.ai.usable, false);
    assert.equal((await call('POST', '/generate', { ...WEEK, mode: 'ki', hash: p.body.hash })).status, 400);
    assert.equal((await call('POST', '/prepare', { from: '2026-02-31' })).status, 400);
    assert.equal((await call('POST', '/generate', { from: '2026-01-05', to: '2026-01-09', mode: 'lokal', hash: 'x' })).status, 404);
  });
  const { ProviderError } = require('../../src/lib/berichtsheft/providers');
  await withApp({ generate: async () => { throw new ProviderError('Claude lehnt den API-Schlüssel ab (401).', { status: 401 }); } }, async ({ call }) => {
    await call('PUT', '/settings', { apiKey: 'sk-ant-123456789', names: [{ term: 'Acme', kind: 'kunde' }] });
    const p = await call('POST', '/prepare', WEEK);
    const g = await call('POST', '/generate', { ...WEEK, mode: 'ki', hash: p.body.hash });
    assert.equal(g.status, 502);
    assert.match(g.body.error, /Schlüssel/);
  });
});

test('Modelle auflisten', async () => {
  await withApp({}, async ({ call, calls }) => {
    assert.equal((await call('POST', '/models', {})).status, 400); // kein Schlüssel
    await call('PUT', '/settings', { apiKey: 'sk-ant-123456789', model: 'm-a' });
    const r = await call('POST', '/models', {});
    assert.deepEqual(r.body, { models: ['m-a', 'm-b'], current: 'm-a', currentFound: true });
    assert.equal(calls.models[0].provider, 'anthropic');
  });
});
