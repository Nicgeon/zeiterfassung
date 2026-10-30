'use strict';

process.env.BERICHTSHEFT_DEBUG = 'aus'; // Tests ohne Diagnose-Ausgabe

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runCli, parseArgs } = require('../../src/lib/berichtsheft/cli');
const { makeStore } = require('../../src/lib/berichtsheft/store');
const { EndOfInput } = require('../../src/lib/berichtsheft/ui');

const fake = { encryptField: (s) => 'enc:' + Buffer.from(s).toString('base64'), decryptField: (s) => Buffer.from(s.slice(4), 'base64').toString() };

function setup(entries) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY, user_id INTEGER, work_date TEXT, start_time TEXT, end_time TEXT, duration_minutes INTEGER, description_enc TEXT, jira_key TEXT, deleted_at TEXT);
    CREATE TABLE berichtsheft_settings (user_id INTEGER PRIMARY KEY, config_enc TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  const ins = db.prepare('INSERT INTO entries (user_id, work_date, start_time, end_time, duration_minutes, description_enc, jira_key) VALUES (1, ?, ?, ?, ?, ?, ?)');
  for (const [date, text, key] of entries) ins.run(date, '08:00', '09:00', 60, fake.encryptField(text), key || null);
  return makeStore(db, fake);
}

/** Skriptgesteuerte Ein-/Ausgabe: answers werden der Reihe nach verbraucht. */
function scripted(answers) {
  const out = [];
  const queue = [...answers];
  const take = () => { if (!queue.length) throw new EndOfInput(); return queue.shift(); };
  return {
    out,
    print: (t = '') => out.push(t),
    ask: async (q, fallback = '') => { out.push(q); return take().trim() || fallback; },
    askSecret: async (q) => { out.push(q); return take(); },
    choose: async (q, keys, fallback) => { out.push(q); const a = (take() || fallback).toLowerCase(); assert.ok(keys.includes(a), `unerlaubte Antwort ${a} bei ${q}`); return a; },
    text: () => out.join('\n'),
  };
}

const entries = [
  ['2026-10-19', 'Backup geprüft für Acme', 'ITPKK-1'],
  ['2026-10-20', 'Lini Update mit Herrn Müller', ''],
  ['2026-10-22', 'Berufsschule: Subnetting', ''],
  ['2026-10-30', 'Außerhalb des Zeitraums', ''],
];

function baseCtx(store, ui, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
  return { ui, store, userId: 1, dataDir, env: {}, today: '2026-10-29', generate: async () => { throw new Error('darf nicht aufgerufen werden'); }, listModels: async () => [], copy: () => true, audit: null, argv: [], ...extra };
}

const GOOD = JSON.stringify({
  zuordnung: [{ id: 1, block: 'betrieb' }, { id: 2, block: 'betrieb' }, { id: 3, block: 'schule' }],
  betrieb: 'Es wurde ein Backup für ein Kunde geprüft und ein Update von Lini gemeinsam mit ein Kollege eingespielt.',
  schule: 'Im Unterricht wurde Subnetting behandelt.',
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['--von', '2026-10-01', '--bis=2026-10-09', '--kopieren', 'namen', 'add']), { flags: { von: '2026-10-01', bis: '2026-10-09', kopieren: true }, positional: ['namen', 'add'] });
  assert.throws(() => parseArgs(['--quatsch']), /Unbekannte Option/);
  assert.throws(() => parseArgs(['--von']), /braucht einen Wert/);
});

test('ganzer Ablauf mit KI: Namen klären, Vorschau, nichts Privates geht raus, Datei wird geschrieben', async () => {
  const store = setup(entries);
  const cfg = store.loadConfig(1);
  cfg.provider = 'openai';
  cfg.keys.openai = 'sk-test';
  cfg.names.push({ term: 'Acme', kind: 'kunde' });
  store.saveConfig(1, cfg);

  // "Müller" ist noch unbekannt, steht aber hinter "Herrn" -> Rückfrage -> person; dann senden, speichern
  const ui = scripted(['p', 'j', 'j']);
  const sent = [];
  const ctx = baseCtx(store, ui, {
    generate: async (opts) => { sent.push(opts); return GOOD; },
    copy: (t) => { ctx.copied = t; return true; },
    argv: ['--kopieren'],
  });
  const code = await runCli(ctx);
  assert.equal(code, 0, ui.text());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].provider, 'openai');
  assert.equal(sent[0].apiKey, 'sk-test');
  for (const secret of ['Acme', 'Müller', 'ITPKK', '2026', 'Montag']) assert.doesNotMatch(sent[0].user + sent[0].system, new RegExp(secret));
  assert.match(sent[0].user, /Backup geprüft für ein Kunde/);
  assert.match(sent[0].user, /Berufsschule: Subnetting \[Stichwort Schule\]/);
  assert.doesNotMatch(sent[0].user, /Außerhalb/);

  // gespeichert, mit Namen gelernt
  assert.ok(store.loadConfig(1).names.some((n) => n.term === 'Müller' && n.kind === 'person'));
  const file = path.join(ctx.dataDir, 'berichtsheft', 'berichtsheft_2026-KW43.txt');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^Betriebliche Tätigkeiten:\nEs wurde ein Backup/);
  assert.match(text, /\n\nBerufsschule \(Unterrichtsthemen\):\nIm Unterricht wurde Subnetting behandelt\.\n$/);
  assert.equal(ctx.copied, text);
  assert.match(ui.text(), /Zeitraum: 19\.10\.2026 – 25\.10\.2026 \(KW 43\/2026\)/);
});

test('Abbruch bei der Vorschau: es wird nichts gesendet', async () => {
  const store = setup(entries);
  const cfg = store.loadConfig(1);
  cfg.keys.anthropic = 'k';
  cfg.names.push({ term: 'Acme', kind: 'kunde' }, { term: 'Müller', kind: 'person' });
  store.saveConfig(1, cfg);
  const ui = scripted(['n']);
  const code = await runCli(baseCtx(store, ui));
  assert.equal(code, 2);
  assert.match(ui.text(), /es wurde nichts gesendet/);
});

test('--ohne-ki sendet nie und schreibt eine lokale Fassung', async () => {
  const store = setup(entries);
  const cfg = store.loadConfig(1);
  cfg.names.push({ term: 'Acme', kind: 'kunde' }, { term: 'Müller', kind: 'person' });
  store.saveConfig(1, cfg);
  const ui = scripted(['j']);
  const target = path.join(os.tmpdir(), `bh-out-${Date.now()}`, 'x.txt');
  const ctx = baseCtx(store, ui, { argv: ['--ohne-ki', '--ausgabe', target] });
  assert.equal(await runCli(ctx), 0, ui.text());
  const saved = fs.readFileSync(target, 'utf8');
  assert.match(saved, /Es wurden folgende Tätigkeiten durchgeführt: Backup geprüft für ein Kunde; Lini Update mit ein Kollege\./);
  assert.match(saved, /Behandelte Unterrichtsthemen: Berufsschule: Subnetting\./);
});

test('--ja bricht ab, wenn Wörter ungeklärt sind', async () => {
  const store = setup(entries);
  const cfg = store.loadConfig(1);
  cfg.keys.anthropic = 'k';
  store.saveConfig(1, cfg);
  const ui = scripted([]);
  const code = await runCli(baseCtx(store, ui, { argv: ['--ja'] }));
  assert.equal(code, 3);
  assert.match(ui.text(), /nicht geklärt/);
});

test('fehlender Schlüssel, abgeschaltete KI und leerer Zeitraum', async () => {
  const store = setup(entries);
  let ui = scripted([]);
  assert.equal(await runCli(baseCtx(store, ui)), 1);
  assert.match(ui.text(), /kein API-Schlüssel/);

  const cfg = store.loadConfig(1);
  cfg.keys.anthropic = 'k';
  store.saveConfig(1, cfg);
  ui = scripted([]);
  assert.equal(await runCli(baseCtx(store, ui, { env: { BERICHTSHEFT_KI: 'aus' } })), 1);
  assert.match(ui.text(), /abgeschaltet/);

  ui = scripted([]);
  assert.equal(await runCli(baseCtx(store, ui, { argv: ['--von', '2026-01-05', '--bis', '2026-01-09'] })), 0);
  assert.match(ui.text(), /Keine Einträge/);
});

test('Sicherheitsnetz: Namen in der KI-Antwort werden entfernt und gemeldet', async () => {
  const store = setup(entries);
  const cfg = store.loadConfig(1);
  cfg.keys.anthropic = 'k';
  cfg.names.push({ term: 'Acme', kind: 'kunde' }, { term: 'Müller', kind: 'person' });
  store.saveConfig(1, cfg);
  const leaky = JSON.stringify({ zuordnung: [], betrieb: 'Am Montag wurde Müller bei Acme geholfen. Danach wurde ITPKK-12 bearbeitet.', schule: 'Subnetting wurde behandelt.' });
  const ui = scripted(['j', 'n']);
  const code = await runCli(baseCtx(store, ui, { generate: async () => leaky }));
  assert.equal(code, 2);
  const shown = ui.text();
  assert.match(shown, /noch Namen, Daten oder Ticketnummern/);
  assert.doesNotMatch(shown.split('── Ergebnis')[1], /Montag|Müller|Acme|ITPKK/);
});

test('namen, stichwoerter und einrichten', async () => {
  const store = setup([]);
  let ui = scripted([]);
  assert.equal(await runCli(baseCtx(store, ui, { argv: ['namen', 'add', 'Lena', 'Schmidt', '--art', 'person'] })), 0);
  assert.equal(await runCli(baseCtx(store, ui, { argv: ['namen', 'erlauben', 'Zeiterfassung'] })), 0);
  assert.equal(await runCli(baseCtx(store, ui, { argv: ['stichwoerter', 'Schule', 'Lernfeld'] })), 0);
  let cfg = store.loadConfig(1);
  assert.deepEqual(cfg.names, [{ term: 'Lena Schmidt', kind: 'person' }]);
  assert.ok(cfg.allow.includes('Zeiterfassung'));
  assert.deepEqual(cfg.keywords, ['Schule', 'Lernfeld']);
  assert.equal(await runCli(baseCtx(store, ui, { argv: ['namen', 'add', 'X'] })), 1);
  assert.equal(await runCli(baseCtx(store, ui, { argv: ['namen', 'entfernen', 'Lena Schmidt'] })), 0);
  assert.deepEqual(store.loadConfig(1).names, []);

  // Einrichtung: Gemini, Standardmodell, Schlüssel, Namenslisten
  ui = scripted(['3', '', 'g-secret', 'Meier, Schulz', 'Acme', '']);
  const ctx = baseCtx(store, ui, { argv: ['einrichten'], listModels: async () => ['gemini-3.8-flash'] });
  assert.equal(await runCli(ctx), 0, ui.text());
  cfg = store.loadConfig(1);
  assert.equal(cfg.provider, 'gemini');
  assert.equal(cfg.models.gemini, 'gemini-3.8-flash');
  assert.equal(cfg.keys.gemini, 'g-secret');
  assert.deepEqual(cfg.names.map((n) => `${n.term}:${n.kind}`), ['Meier:person', 'Schulz:person', 'Acme:kunde']);
  assert.match(ui.text(), /Schlüssel funktioniert/);
  assert.doesNotMatch(ui.text(), /g-secret/);
});

test('unbekannte Großwörter werden einmal abgefragt, Namen daraus gelernt und nicht erneut gefragt', async () => {
  const store = setup([['2026-10-19', 'Besuch bei Kloska Group wegen Backup', '']]);
  const cfg = store.loadConfig(1);
  cfg.keys.anthropic = 'k';
  store.saveConfig(1, cfg);

  const sent = [];
  const generate = async (o) => { sent.push(o.user); return JSON.stringify({ zuordnung: [], betrieb: 'Ein Kunde wurde besucht.', schule: '' }); };
  // Liste: 1) Besuch 2) Kloska 3) Group (Backup ist ein bekannter IT-Begriff) -> 2 und 3 sind der Kunde
  let ui = scripted(['2, 3', 'k', 'k', 'j', 'n']);
  assert.equal(await runCli(baseCtx(store, ui, { generate })), 2, ui.text());
  assert.match(ui.text(), /2\) Kloska/);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /Kloska|Group/);
  const saved = store.loadConfig(1);
  assert.deepEqual(saved.names.map((n) => n.term).sort(), ['Group', 'Kloska']);
  assert.deepEqual(saved.reviewed.sort(), ['besuch']);

  // zweiter Lauf: keine Rückfrage zu Wörtern mehr
  ui = scripted(['j', 'n']);
  await runCli(baseCtx(store, ui, { generate }));
  assert.doesNotMatch(ui.text(), /noch nicht kenne/);
});

test('Fehler des Anbieters: Verlauf der Versuche wird im Terminal gezeigt, --debug setzt die Diagnose', async () => {
  const { ProviderError } = require('../../src/lib/berichtsheft/providers');
  const store = setup([['2026-10-19', 'Backup geprüft', '']]);
  const cfg = store.loadConfig(1);
  cfg.provider = 'noah';
  cfg.keys.noah = 'k';
  store.saveConfig(1, cfg);
  const failing = async () => {
    const err = new ProviderError('Noah AI: Zeitüberschreitung auf dem Server (504)', { status: 504, retryable: true });
    err.trace = ['Versuch mit Datenstrom: Fehler nach 120.1 s – 504', 'Versuch ohne Datenstrom: Fehler nach 119.8 s – 504'];
    throw err;
  };
  const ui = scripted(['j']);
  const prev = process.env.BERICHTSHEFT_DEBUG;
  const code = await runCli(baseCtx(store, ui, { generate: failing, argv: ['--debug', '--kein-stream'] }));
  assert.equal(code, 1);
  assert.equal(process.env.BERICHTSHEFT_DEBUG, '1');
  assert.equal(process.env.BERICHTSHEFT_STREAM, 'aus');
  assert.match(ui.text(), /Verlauf der Versuche:\n  - Versuch mit Datenstrom: Fehler nach 120\.1 s/);
  assert.match(ui.text(), /mit --debug erneut ausführen/);
  process.env.BERICHTSHEFT_DEBUG = prev === undefined ? 'aus' : prev;
  delete process.env.BERICHTSHEFT_STREAM;
});
