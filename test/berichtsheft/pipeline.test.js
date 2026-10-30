'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { buildItems, localReport, aiReport } = require('../../src/lib/berichtsheft/pipeline');
const { parseAnswer, checkLimits, countLines, extractJson, userMessage } = require('../../src/lib/berichtsheft/prompt');
const { makeStore, resolveKey, resolveModel, defaultConfig } = require('../../src/lib/berichtsheft/store');
const { formatReport, lineSummary } = require('../../src/lib/berichtsheft/report');

const vocab = { names: [{ term: 'Müller', kind: 'person' }, { term: 'Acme', kind: 'kunde' }], allow: ['Lini'] };
const keywords = ['Berufsschule', 'Unterricht'];

const entries = [
  { id: 1, date: '2026-10-19', description: 'Backup geprüft für Acme', jiraKey: 'ITPKK-1', minutes: 30, school: false },
  { id: 2, date: '2026-10-20', description: 'backup geprüft für acme', jiraKey: 'ITPKK-1', minutes: 45, school: false },
  { id: 3, date: '2026-10-21', description: 'Lini Update mit Herrn Müller', jiraKey: '', minutes: 60, school: false },
  { id: 4, date: '2026-10-22', description: 'Berufsschule: Subnetting', jiraKey: '', minutes: 300, school: false },
  { id: 5, date: '2026-10-23', description: '', jiraKey: 'ITPKB-9', minutes: 15, school: false },
  { id: 6, date: '2026-10-23', description: '', jiraKey: '', minutes: 15, school: false },
  { id: 7, date: '2026-10-24', description: 'Routing Grundlagen', jiraKey: '', minutes: 120, school: true },
];

test('buildItems anonymisiert, fasst Doppelte zusammen und merkt Hinweise', () => {
  const { items, replaced } = buildItems(entries, vocab, keywords);
  assert.deepEqual(items.map((i) => i.text), [
    'Backup geprüft für ein Kunde',
    'Lini Update mit ein Kollege',
    'Berufsschule: Subnetting',
    'Bearbeitung eines Tickets',
    'Routing Grundlagen',
  ]);
  assert.equal(items[0].count, 2);
  assert.equal(items[0].minutes, 75);
  assert.deepEqual(items.map((i) => i.id), [1, 2, 3, 4, 5]);
  assert.equal(items[2].keyword, true);
  assert.equal(items[2].school, false);
  assert.equal(items[4].school, true);
  assert.equal(replaced.length, 3);
  for (const i of items) assert.doesNotMatch(i.text, /Acme|Müller|ITPKK/);
});

test('Nutzernachricht trägt Hinweise und Häufigkeit', () => {
  const { items } = buildItems(entries, vocab, keywords);
  const msg = userMessage(items);
  assert.match(msg, /1\. Backup geprüft für ein Kunde \(2x erfasst\)/);
  assert.match(msg, /3\. Berufsschule: Subnetting \[Stichwort Schule\]/);
  assert.match(msg, /5\. Routing Grundlagen \[Schule: sicher\]/);
  assert.doesNotMatch(msg, /Acme|Müller|ITPKK|2026/);
});

test('localReport trennt nach Markierung und Stichwort', () => {
  const { items } = buildItems(entries, vocab, keywords);
  const r = localReport(items);
  assert.match(r.betrieb, /Backup geprüft für ein Kunde; Lini Update mit ein Kollege; Bearbeitung eines Tickets\.$/);
  assert.match(r.schule, /Berufsschule: Subnetting; Routing Grundlagen\.$/);
});

test('parseAnswer: Markierung gewinnt, fehlende Zuordnung wird Betrieb, Code-Zaun wird entfernt', () => {
  const { items } = buildItems(entries, vocab, keywords);
  const raw = '```json\n' + JSON.stringify({ zuordnung: [{ id: 1, block: 'betrieb' }, { id: 5, block: 'betrieb' }, { id: 3, block: 'schule' }], betrieb: ' A ', schule: ' B ' }) + '\n```';
  const r = parseAnswer(raw, items);
  assert.equal(r.assignment.get(5), 'schule');
  assert.equal(r.assignment.get(3), 'schule');
  assert.equal(r.assignment.get(2), 'betrieb');
  assert.equal(r.betrieb, 'A');
  assert.throws(() => parseAnswer('{"betrieb": 1}', items), /Format/);
  assert.throws(() => extractJson('kein json'), /JSON/);
});

test('countLines bricht bei der Zeilenbreite um', () => {
  assert.equal(countLines('', 95), 0);
  assert.equal(countLines('wort '.repeat(40).trim(), 95), 3); // 199 Zeichen -> 3 Zeilen
  assert.equal(countLines('a\n\nb', 95), 2);
});

test('checkLimits: zu lang, Aufzählung, leere Blöcke, zu kurz', () => {
  const long = 'wort '.repeat(300).trim();
  assert.ok(checkLimits({ betrieb: long, schule: '' }, { hasSchool: false, hasBetrieb: true }).problems.some((p) => p.hard && /Zeilen lang/.test(p.text)));
  assert.ok(checkLimits({ betrieb: '- a\n- b', schule: '' }, { hasSchool: false, hasBetrieb: true }).problems.some((p) => /Aufzählung/.test(p.text)));
  assert.ok(checkLimits({ betrieb: '', schule: 'x' }, { hasSchool: false, hasBetrieb: true }).problems.some((p) => p.hard));
  assert.ok(checkLimits({ betrieb: 'kurz', schule: '' }, { hasSchool: false, hasBetrieb: true }).problems.every((p) => !p.hard));
  const good = 'wort '.repeat(80).trim();
  assert.equal(checkLimits({ betrieb: good, schule: '' }, { hasSchool: false, hasBetrieb: true }).problems.length, 0);
});

test('aiReport: ein zweiter Versuch bei harten Verstößen', async () => {
  const { items } = buildItems(entries, vocab, keywords);
  const tooLong = JSON.stringify({ zuordnung: [], betrieb: 'wort '.repeat(300), schule: 'Subnetting wurde behandelt.' });
  const good = JSON.stringify({ zuordnung: [{ id: 3, block: 'schule' }], betrieb: 'wort '.repeat(60).trim(), schule: 'Subnetting und Routing wurden behandelt.' });
  const calls = [];
  const generateImpl = async (opts) => { calls.push(opts.user); return calls.length === 1 ? tooLong : good; };
  let retried = null;
  const r = await aiReport({ items, provider: 'anthropic', model: 'm', apiKey: 'k', generateImpl, onRetry: (p) => { retried = p; } });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /Deine letzte Antwort war nicht in Ordnung/);
  assert.ok(retried);
  assert.equal(r.problems.filter((p) => p.hard).length, 0);
  assert.match(r.schule, /Subnetting/);
});

test('aiReport: zwei schlechte Antworten liefern das Ergebnis mit Problemen', async () => {
  const { items } = buildItems(entries, vocab, keywords);
  const bad = JSON.stringify({ zuordnung: [], betrieb: 'wort '.repeat(300), schule: 'x' });
  const r = await aiReport({ items, provider: 'anthropic', model: 'm', apiKey: 'k', generateImpl: async () => bad });
  assert.ok(r.problems.some((p) => p.hard));
});

test('aiReport: unbrauchbare Antwort beim zweiten Mal wirft', async () => {
  const { items } = buildItems(entries, vocab, keywords);
  await assert.rejects(aiReport({ items, provider: 'anthropic', model: 'm', apiKey: 'k', generateImpl: async () => 'Entschuldigung, das kann ich nicht.' }), /unbrauchbar/);
});

test('Ausgabeformat mit beiden Überschriften', () => {
  const t = formatReport({ betrieb: 'Betrieb.', schule: '' });
  assert.match(t, /^Betriebliche Tätigkeiten:\nBetrieb\.\n\nBerufsschule \(Unterrichtsthemen\):\nIn diesem Zeitraum/);
  assert.deepEqual(lineSummary({ betrieb: 'a', schule: 'b' }), { work: 1, school: 1, total: 2 });
});

test('Store: Einstellungen verschlüsselt speichern und laden, Schlüssel aus der Umgebung', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, user_id INTEGER, work_date TEXT, start_time TEXT, end_time TEXT, duration_minutes INTEGER, description_enc TEXT, jira_key TEXT, deleted_at TEXT);
    CREATE TABLE berichtsheft_settings (user_id INTEGER PRIMARY KEY, config_enc TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  const fake = { encryptField: (s) => 'enc:' + Buffer.from(s).toString('base64'), decryptField: (s) => Buffer.from(s.slice(4), 'base64').toString() };
  const store = makeStore(db, fake);
  assert.deepEqual(store.loadConfig(1), defaultConfig());
  const cfg = store.loadConfig(1);
  cfg.provider = 'gemini';
  cfg.keys.gemini = 'geheim';
  cfg.names.push({ term: 'Müller', kind: 'person' });
  store.saveConfig(1, cfg);
  assert.doesNotMatch(db.prepare('SELECT config_enc FROM berichtsheft_settings').get().config_enc, /geheim/);
  const again = store.loadConfig(1);
  assert.equal(again.provider, 'gemini');
  assert.equal(again.keys.gemini, 'geheim');
  assert.deepEqual(again.allow, ['Lini']);
  assert.equal(store.loadConfig(2).provider, 'anthropic'); // andere Person: Standard
  assert.equal(resolveKey(again, 'gemini', {}), 'geheim');
  assert.equal(resolveKey(defaultConfig(), 'openai', { OPENAI_API_KEY: 'envkey' }), 'envkey');
  assert.equal(resolveKey(defaultConfig(), 'gemini', { GOOGLE_API_KEY: 'g' }), 'g');
  assert.equal(resolveModel(defaultConfig(), 'anthropic'), 'claude-haiku-5-5');
  assert.equal(resolveModel(again, 'anthropic', 'claude-sonnet-5-5'), 'claude-sonnet-5-5');

  db.prepare("INSERT INTO entries VALUES (1, 1, '2026-10-19', '08:00', '09:00', 60, ?, 'ITPKK-1', NULL)").run(fake.encryptField('Aufgabe A'));
  db.prepare("INSERT INTO entries VALUES (2, 1, '2026-10-20', '08:00', '09:00', 60, ?, NULL, '2026-10-21')").run(fake.encryptField('gelöscht'));
  db.prepare("INSERT INTO entries VALUES (3, 2, '2026-10-19', '08:00', '09:00', 60, ?, NULL, NULL)").run(fake.encryptField('fremd'));
  const list = store.loadEntries(1, '2026-10-19', '2026-10-25');
  assert.deepEqual(list.map((e) => e.description), ['Aufgabe A']);
  assert.equal(list[0].school, false);
});

test('Kleine Modelle (Noah AI, kompatibel) bekommen den kurzen Prompt, große den ausführlichen', async () => {
  const { items } = buildItems(entries, vocab, keywords);
  const seen = {};
  const answer = JSON.stringify({ schule_ids: [3, 5], betrieb: 'wort '.repeat(60).trim(), schule: 'Subnetting und Routing wurden behandelt.' });
  for (const provider of ['noah', 'kompatibel', 'anthropic']) {
    await aiReport({ items, provider, model: 'm', apiKey: 'k', generateImpl: async (o) => { seen[provider] = o.system; return answer; } });
  }
  assert.ok(seen.noah.length < 1300 && seen.noah.includes('schule_ids'));
  assert.equal(seen.kompatibel, seen.noah);
  assert.ok(seen.anthropic.length > 1800 && !seen.anthropic.includes('schule_ids'));
  assert.ok(seen.noah.length < seen.anthropic.length / 1.5);
});

test('parseAnswer versteht die Kurzform schule_ids', () => {
  const { items } = buildItems(entries, vocab, keywords);
  const r = parseAnswer({ schule_ids: [3, '4', 99], betrieb: 'A', schule: 'B' }, items);
  assert.equal(r.assignment.get(3), 'schule');
  assert.equal(r.assignment.get(4), 'schule');
  assert.equal(r.assignment.get(1), 'betrieb');
  assert.equal(r.assignment.get(5), 'schule'); // markiert -> immer Schule
  assert.throws(() => parseAnswer({ betrieb: 'A', schule: 'B' }, items), /Format/);
});
