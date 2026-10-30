'use strict';

// Ablauf des Befehls "berichtsheft". Alle Abhaengigkeiten (Datenbank, Netzwerk, Zwischenablage,
// Ein-/Ausgabe) kommen ueber ctx herein; src/scripts/berichtsheft.js verdrahtet sie mit der Wirklichkeit.

const path = require('path');
const { resolvePeriod, periodLabel } = require('./period');
const { findCandidates, findUnreviewedWords, scrubOutput, KINDS, KIND_PHRASE } = require('./anonymize');
const { buildItems, localReport, aiReport } = require('./pipeline');
const { PROVIDERS, resolveKey, resolveModel } = require('./store');
const { formatReport, lineSummary, saveReport, saveReportTo, defaultOutputDir } = require('./report');
const { EndOfInput } = require('./ui');
const { isoWeek } = require('../dates');

const FLAGS_WITH_VALUE = new Set(['von', 'bis', 'benutzer', 'anbieter', 'modell', 'ausgabe', 'art']);
const BOOLEAN_FLAGS = new Set(['kopieren', 'ohne-ki', 'ja', 'hilfe', 'lokal']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { flags.hilfe = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [rawName, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const name = rawName;
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    if (!FLAGS_WITH_VALUE.has(name)) throw new Error(`Unbekannte Option --${name}. "berichtsheft hilfe" zeigt alle Optionen.`);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Die Option --${name} braucht einen Wert.`);
    flags[name] = value;
  }
  return { flags, positional };
}

const HELP = `
Berichtsheft-Text aus den erfassten Einträgen erzeugen

Aufruf:
  npm run berichtsheft -- [Befehl] [Optionen]

Befehle:
  (ohne)                 Text für einen Zeitraum erzeugen (Standard: letzte Kalenderwoche)
  einrichten             KI-Anbieter, Modell und API-Schlüssel festlegen (einmalig)
  modelle                Verfügbare Modelle des Anbieters anzeigen (prüft auch den Schlüssel)
  namen                  Namensliste anzeigen
  namen add <Begriff> --art person|kunde|firma
  namen erlauben <Begriff>      Begriff nie ersetzen (z. B. interne Programmnamen)
  namen entfernen <Begriff>     Begriff aus Namensliste/Erlaubnisliste löschen
  stichwoerter <Wort> ...       Stichwörter setzen, die auf Berufsschule hinweisen
  hilfe                  Diese Hilfe

Optionen:
  --von JJJJ-MM-TT       Beginn des Zeitraums
  --bis JJJJ-MM-TT       Ende des Zeitraums (ohne beides: letzte Kalenderwoche)
  --anbieter NAME        anthropic | openai | gemini | noah | kompatibel (sonst gespeicherter Anbieter)
  --modell ID            Modell überschreiben
  --ausgabe PFAD         Textdatei (Standard: Datenordner/berichtsheft/berichtsheft_<Zeitraum>.txt)
  --kopieren             Ergebnis zusätzlich in die Zwischenablage legen
  --ohne-ki              Nichts senden: nur lokal anonymisieren und grob zusammenstellen
  --ja                   Rückfragen mit "Ja" beantworten (bricht ab, wenn Namen unklar sind)
  --benutzer NAME        Konto (nur nötig, wenn mehrere Konten existieren)

Ablauf: Einträge laden → lokal anonymisieren → Vorschau (nur das geht an die KI) → KI →
Vorschau des Ergebnisses → speichern. Ohne Ihre Bestätigung wird nichts gesendet.
`;

const PROVIDER_ORDER = ['anthropic', 'openai', 'gemini', 'noah', 'kompatibel'];

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function vocabOf(config) {
  return { names: config.names, allow: config.allow };
}

function persist(ctx, config, note) {
  ctx.store.saveConfig(ctx.userId, config);
  if (ctx.audit && note) ctx.audit(ctx.userId, 'berichtsheft_settings_changed', note);
}

// --- einrichten ----------------------------------------------------------------

async function cmdSetup(ctx, flags) {
  const { ui } = ctx;
  const config = ctx.store.loadConfig(ctx.userId);
  ui.print('Einrichtung der KI-Anbindung (gilt nur für dieses Konto).');
  ui.print('Hinweis: Bei Claude, ChatGPT, Gemini und Noah AI verlässt der ANONYMISIERTE Text den Rechner.');
  ui.print('Nach der Anonymisierung zeigt der Befehl jedes Mal eine Vorschau, bevor etwas gesendet wird.\n');
  PROVIDER_ORDER.forEach((p, i) => ui.print(`  ${i + 1}) ${PROVIDERS[p].label}${config.provider === p ? '  (aktuell)' : ''}`));
  const current = PROVIDER_ORDER.indexOf(config.provider) + 1;
  let provider = flags.anbieter;
  if (!provider) {
    const answer = await ui.ask(`Anbieter [${current}]: `, String(current));
    provider = PROVIDER_ORDER[Number(answer) - 1] || answer.toLowerCase();
  }
  if (!PROVIDERS[provider]) throw new Error(`Unbekannter Anbieter "${provider}".`);
  config.provider = provider;

  if (PROVIDERS[provider].models) ui.print(`Verfügbare Modelle: ${PROVIDERS[provider].models.join(', ')}`);
  const defaultModel = resolveModel(config, provider);
  config.models[provider] = flags.modell || (await ui.ask(`Modell [${defaultModel || 'bitte angeben'}]: `, defaultModel));
  if (!config.models[provider]) throw new Error('Ein Modell wird benötigt.');

  if (provider === 'kompatibel') {
    const base = await ui.ask(`Basis-Adresse [${config.baseUrls[provider] || 'http://localhost:11434/v1'}]: `, config.baseUrls[provider] || 'http://localhost:11434/v1');
    config.baseUrls[provider] = base;
  }
  const hasKey = !!resolveKey(config, provider, ctx.env);
  const keyPrompt = provider === 'kompatibel'
    ? 'API-Schlüssel (leer lassen, wenn keiner nötig ist): '
    : `API-Schlüssel${hasKey ? ' (Enter = vorhandenen behalten)' : ''}: `;
  const key = await ui.askSecret(keyPrompt);
  if (key) config.keys[provider] = key;

  persist(ctx, config, `provider=${provider}`);
  ui.print('\nGespeichert (verschlüsselt in der Datenbank).');

  const apiKey = resolveKey(config, provider, ctx.env);
  if (apiKey || provider === 'kompatibel') {
    try {
      const models = await ctx.listModels({ provider, apiKey, baseUrl: config.baseUrls[provider] });
      const ok = models.includes(config.models[provider]);
      ui.print(`Schlüssel funktioniert (${models.length} Modelle sichtbar).${ok ? '' : ` ACHTUNG: Das Modell "${config.models[provider]}" steht nicht in der Liste – "berichtsheft modelle" zeigt die verfügbaren.`}`);
    } catch (err) {
      ui.print(`Test fehlgeschlagen: ${err.message}`);
    }
  } else {
    ui.print('Es ist noch kein Schlüssel hinterlegt (auch nicht als Umgebungsvariable).');
  }

  ui.print('\nNamen, die nie an eine KI gehen sollen (Enter = überspringen, mehrere mit Komma trennen):');
  for (const kind of KINDS) {
    const label = { person: 'Personen (Kollegen, Ausbilder ...)', kunde: 'Kunden', firma: 'Firmen' }[kind];
    const answer = await ui.ask(`  ${label}: `);
    for (const term of answer.split(',').map((t) => t.trim()).filter(Boolean)) addName(config, term, kind);
  }
  persist(ctx, config, 'names');
  ui.print('\nFertig. Aufruf: npm run berichtsheft');
}

function addName(config, term, kind) {
  const t = term.trim();
  config.allow = config.allow.filter((a) => a.toLowerCase() !== t.toLowerCase());
  const existing = config.names.find((n) => n.term.toLowerCase() === t.toLowerCase());
  if (existing) existing.kind = kind;
  else config.names.push({ term: t, kind });
}

function allowTerm(config, term) {
  const t = term.trim();
  config.names = config.names.filter((n) => n.term.toLowerCase() !== t.toLowerCase());
  if (!config.allow.some((a) => a.toLowerCase() === t.toLowerCase())) config.allow.push(t);
}

// --- modelle / namen / stichwoerter -------------------------------------------------

async function cmdModels(ctx, flags) {
  const config = ctx.store.loadConfig(ctx.userId);
  const provider = flags.anbieter || config.provider;
  if (!PROVIDERS[provider]) throw new Error(`Unbekannter Anbieter "${provider}".`);
  const apiKey = resolveKey(config, provider, ctx.env);
  if (!apiKey && provider !== 'kompatibel') throw new Error(`Für ${PROVIDERS[provider].label} ist kein API-Schlüssel hinterlegt ("berichtsheft einrichten").`);
  const models = await ctx.listModels({ provider, apiKey, baseUrl: config.baseUrls[provider] });
  ctx.ui.print(`${PROVIDERS[provider].label}: ${models.length} Modelle (aktuell gewählt: ${resolveModel(config, provider)})`);
  for (const m of models.sort()) ctx.ui.print(`  ${m}`);
}

function cmdNames(ctx, flags, positional) {
  const { ui } = ctx;
  const config = ctx.store.loadConfig(ctx.userId);
  const [sub, ...rest] = positional;
  const term = rest.join(' ').trim();
  if (!sub) {
    ui.print('Wird ersetzt:');
    if (!config.names.length) ui.print('  (leer)');
    for (const n of config.names) ui.print(`  ${n.term}  →  ${KIND_PHRASE[n.kind]}  (${n.kind})`);
    ui.print('Wird nie ersetzt:');
    ui.print(`  ${config.allow.join(', ') || '(leer)'}`);
    ui.print(`Stichwörter für Berufsschule: ${config.keywords.join(', ') || '(keine)'}`);
    return;
  }
  if (!term) throw new Error(`"namen ${sub}" braucht einen Begriff.`);
  if (sub === 'add') {
    const kind = flags.art;
    if (!KINDS.includes(kind)) throw new Error(`--art muss person, kunde oder firma sein.`);
    addName(config, term, kind);
    ui.print(`"${term}" wird künftig durch "${KIND_PHRASE[kind]}" ersetzt.`);
  } else if (sub === 'erlauben') {
    allowTerm(config, term);
    ui.print(`"${term}" wird nie ersetzt.`);
  } else if (sub === 'entfernen') {
    const before = config.names.length + config.allow.length;
    config.names = config.names.filter((n) => n.term.toLowerCase() !== term.toLowerCase());
    config.allow = config.allow.filter((a) => a.toLowerCase() !== term.toLowerCase());
    ui.print(before === config.names.length + config.allow.length ? `"${term}" stand in keiner Liste.` : `"${term}" entfernt.`);
  } else {
    throw new Error(`Unbekannter Unterbefehl "namen ${sub}" (add, erlauben, entfernen).`);
  }
  persist(ctx, config, 'names');
}

function cmdKeywords(ctx, positional) {
  const config = ctx.store.loadConfig(ctx.userId);
  if (positional.length) {
    config.keywords = positional.map((w) => w.trim()).filter(Boolean);
    persist(ctx, config, 'keywords');
  }
  ctx.ui.print(`Stichwörter für Berufsschule: ${config.keywords.join(', ') || '(keine)'}`);
}

// --- Haupt-Ablauf -------------------------------------------------------------------------

/**
 * Klaert unbekannte Woerter, bevor etwas gesendet wird - jedes Wort wird nur ein einziges Mal gefragt:
 *  1) verdaechtige Muster (Herr/Frau + Name, Firma mit GmbH, Vor-/Nachname ...) einzeln,
 *  2) alle uebrigen noch nie gesichteten Grossbuchstaben-Woerter als Liste zum Ankreuzen.
 * Gibt die Woerter zurueck, ueber die nicht entschieden wurde.
 */
async function resolveCandidates(ctx, config, texts, { interactive }) {
  const { ui } = ctx;
  const unresolved = [];
  const seen = new Set();
  for (const text of texts) {
    for (const c of findCandidates(text, vocabOf(config))) {
      if (seen.has(c.word) || config.reviewed.includes(c.word.toLowerCase())) continue;
      seen.add(c.word);
      if (!interactive) { unresolved.push(c); continue; }
      ui.print(`\nVerdächtiges Wort: "${c.word}" (${c.reason})`);
      const answer = await ui.choose('  [p]erson / [k]unde / [f]irma / [b]egriff (harmlos, nie ersetzen) / [s]päter (Enter): ', ['p', 'k', 'f', 'b', 's'], 's');
      if (answer === 's') { unresolved.push(c); continue; }
      if (answer === 'b') allowTerm(config, c.word);
      else addName(config, c.word, { p: 'person', k: 'kunde', f: 'firma' }[answer]);
      persist(ctx, config);
    }
  }

  // Woerter, die durch die Ersetzung inzwischen nicht mehr vorkommen, sind bereits erledigt.
  const words = [...new Set(texts.flatMap((t) => findUnreviewedWords(t, vocabOf(config), config.reviewed)))];
  if (!words.length) return unresolved;
  if (!interactive) return [...unresolved, ...words.map((word) => ({ word, reason: 'noch nicht geprüft' }))];

  ui.print('\nWörter mit Großbuchstaben, die ich noch nicht kenne (so fällt kein Name unbemerkt durch):');
  words.forEach((w, i) => ui.print(`  ${String(i + 1).padStart(2)}) ${w}`));
  const answer = await ui.ask('Welche davon sind Namen von Personen, Kunden oder Firmen? Nummern mit Komma (Enter = keine): ');
  const picked = new Set(answer.split(/[\s,;]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1 && n <= words.length));
  for (const n of picked) {
    const word = words[n - 1];
    const kind = await ui.choose(`  "${word}": [p]erson / [k]unde / [f]irma: `, ['p', 'k', 'f'], 'p');
    addName(config, word, { p: 'person', k: 'kunde', f: 'firma' }[kind]);
  }
  config.reviewed = [...new Set([...config.reviewed, ...words.filter((_, i) => !picked.has(i + 1)).map((w) => w.toLowerCase())])];
  persist(ctx, config);
  return unresolved;
}

async function cmdRun(ctx, flags) {
  const { ui } = ctx;
  const config = ctx.store.loadConfig(ctx.userId);
  const period = resolvePeriod({ von: flags.von, bis: flags.bis }, ctx.today);
  const label = periodLabel(period);
  const { week, year } = isoWeek(period.from);
  const weekNote = label.includes('KW') ? ` (KW ${week}/${year})` : '';
  ui.print(`Zeitraum: ${fmtDate(period.from)} – ${fmtDate(period.to)}${weekNote}`);

  const entries = ctx.store.loadEntries(ctx.userId, period.from, period.to);
  if (!entries.length) {
    ui.print('Keine Einträge in diesem Zeitraum – nichts zu tun.');
    return 0;
  }

  const useAi = !flags['ohne-ki'];
  const provider = flags.anbieter || config.provider;
  if (useAi && !PROVIDERS[provider]) throw new Error(`Unbekannter Anbieter "${provider}".`);
  const model = resolveModel(config, provider, flags.modell);
  const apiKey = useAi ? resolveKey(config, provider, ctx.env) : '';
  if (useAi) {
    if (ctx.env.BERICHTSHEFT_KI === 'aus' && provider !== 'kompatibel') {
      throw new Error('Die Nutzung externer KI-Anbieter ist hier abgeschaltet (BERICHTSHEFT_KI=aus). "--ohne-ki" funktioniert weiterhin.');
    }
    if (!apiKey && provider !== 'kompatibel') {
      throw new Error(`Für ${PROVIDERS[provider].label} ist kein API-Schlüssel hinterlegt. Bitte "npm run berichtsheft -- einrichten" ausführen (oder ${PROVIDERS[provider].env[0]} setzen), oder mit --ohne-ki arbeiten.`);
    }
  }

  // 1) Anonymisieren; unklare Woerter einmal klaeren
  let built = buildItems(entries, vocabOf(config), config.keywords);
  const interactive = !flags.ja;
  const unresolved = await resolveCandidates(ctx, config, built.items.map((i) => i.text), { interactive });
  built = buildItems(entries, vocabOf(config), config.keywords);
  if (flags.ja && unresolved.length) {
    ui.print(`Abbruch: ${unresolved.length} Wort/Wörter sind nicht geklärt (${unresolved.map((c) => c.word).join(', ')}).`);
    ui.print('Bitte einmal ohne --ja ausführen (jedes Wort wird nur ein Mal gefragt) oder mit "namen add/erlauben" festlegen.');
    return 3;
  }
  if (!built.items.length) {
    ui.print('Die Einträge enthalten keinen verwertbaren Text.');
    return 0;
  }

  // 2) Vorschau 1
  for (;;) {
    ui.print(`\n${entries.length} Einträge → ${built.items.length} Stichpunkte nach der Anonymisierung:`);
    for (const it of built.items) {
      const tags = [it.school ? 'Schule: markiert' : it.keyword ? 'Stichwort Schule' : '', it.count > 1 ? `${it.count}x` : ''].filter(Boolean);
      ui.print(`  ${it.id}. ${it.text}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
    }
    if (built.replaced.length) {
      const counts = new Map();
      for (const r of built.replaced) counts.set(`${r.from.trim()} → ${KIND_PHRASE[r.kind]}`, (counts.get(`${r.from.trim()} → ${KIND_PHRASE[r.kind]}`) || 0) + 1);
      ui.print(`Ersetzt (nur lokal sichtbar): ${[...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join('; ')}`);
    }
    ui.print('Entfernt: Datum, Uhrzeit, Wochentage, Ticketnummern, Links, E-Mails, Telefon- und IP-Adressen.');
    if (!useAi) { ui.print('Modus --ohne-ki: Es wird nichts gesendet.'); break; }
    ui.print(`\nZiel: ${PROVIDERS[provider].label}, Modell ${model}${provider === 'kompatibel' ? ` (${config.baseUrls[provider] || 'lokal'})` : provider === 'noah' ? ' (ai.noahkoning.de)' : ''}`);
    if (flags.ja) break;
    const answer = await ui.choose('Genau diesen Text senden? [j]a / [n]ein / [a] Name ergänzen: ', ['j', 'n', 'a'], 'n');
    if (answer === 'j') break;
    if (answer === 'n') { ui.print('Abgebrochen – es wurde nichts gesendet.'); return 2; }
    const term = await ui.ask('  Begriff, der ersetzt werden soll: ');
    if (term) {
      const kind = await ui.choose('  Art: [p]erson / [k]unde / [f]irma: ', ['p', 'k', 'f'], 'p');
      addName(config, term, { p: 'person', k: 'kunde', f: 'firma' }[kind]);
      persist(ctx, config);
      built = buildItems(entries, vocabOf(config), config.keywords);
    }
  }

  // 3) Text erzeugen (und bei Bedarf neu)
  for (;;) {
    let result;
    if (useAi) {
      ui.print('\nSende an die KI …');
      result = await aiReport({
        items: built.items, provider, model, apiKey, baseUrl: config.baseUrls[provider], lineWidth: config.lineWidth,
        generateImpl: ctx.generate,
        onRetry: (problems) => ui.print(`  Antwort nachbessern lassen (${problems.join(' ')})`),
      });
    } else {
      result = { ...localReport(built.items), problems: [] };
    }

    // Sicherheitsnetz: nichts Verbotenes im Ergebnis
    const scrubbedWork = scrubOutput(result.betrieb, vocabOf(config));
    const scrubbedSchool = scrubOutput(result.schule, vocabOf(config));
    const warnings = result.problems.map((p) => p.text);
    if (scrubbedWork.changed || scrubbedSchool.changed) warnings.push('Im Ergebnis standen noch Namen, Daten oder Ticketnummern – sie wurden entfernt. Bitte den Text prüfen.');
    const final = { betrieb: scrubbedWork.text, schule: scrubbedSchool.text };
    const text = formatReport(final);
    const lines = lineSummary(final, config.lineWidth);

    ui.print('\n── Ergebnis ─────────────────────────────────────────');
    ui.print(text.trimEnd());
    ui.print('─────────────────────────────────────────────────────');
    ui.print(`Umfang: ca. ${lines.total} Zeilen (Betrieb ${lines.work}, Schule ${lines.school})`);
    if (result.assignment) {
      ui.print('Zuordnung der Stichpunkte:');
      for (const it of built.items) ui.print(`  ${it.id}. ${result.assignment.get(it.id) === 'schule' ? 'Berufsschule' : 'Betrieb     '}  ${it.text}`);
    }
    for (const w of warnings) ui.print(`Hinweis: ${w}`);

    const choice = flags.ja ? 'j' : await ui.choose('\nSpeichern? [j]a / [n]ein / [r] neu erzeugen: ', useAi ? ['j', 'n', 'r'] : ['j', 'n'], 'j');
    if (choice === 'r') continue;
    if (choice === 'n') { ui.print('Verworfen – nichts gespeichert.'); return 2; }

    const file = flags.ausgabe ? saveReportTo(path.resolve(flags.ausgabe), text) : saveReport(defaultOutputDir(ctx.dataDir), label, text);
    ui.print(`\nGespeichert: ${path.resolve(file)}`);
    if (flags.kopieren) ui.print(ctx.copy(text) ? 'In die Zwischenablage kopiert.' : 'Zwischenablage nicht verfügbar – den Text bitte aus der Datei kopieren.');
    if (ctx.audit) ctx.audit(ctx.userId, 'berichtsheft_generated', `${useAi ? `${provider}/${model}` : 'ohne KI'}, ${entries.length} Einträge, ${label}`);
    return 0;
  }
}

async function runCli(ctx) {
  let parsed;
  try {
    parsed = parseArgs(ctx.argv);
  } catch (err) {
    ctx.ui.print(`Fehler: ${err.message}`);
    return 1;
  }
  const { flags, positional } = parsed;
  const [command, ...rest] = positional;
  try {
    if (flags.hilfe || command === 'hilfe' || command === 'help') { ctx.ui.print(HELP); return 0; }
    if (command === 'einrichten') { await cmdSetup(ctx, flags); return 0; }
    if (command === 'modelle') { await cmdModels(ctx, flags); return 0; }
    if (command === 'namen') { cmdNames(ctx, flags, rest); return 0; }
    if (command === 'stichwoerter') { cmdKeywords(ctx, rest); return 0; }
    if (command && command !== 'erzeugen') { ctx.ui.print(`Unbekannter Befehl "${command}".${HELP}`); return 1; }
    return await cmdRun(ctx, flags);
  } catch (err) {
    if (err instanceof EndOfInput) { ctx.ui.print('Abgebrochen.'); return 2; }
    ctx.ui.print(`Fehler: ${err.message}`);
    return 1;
  }
}

module.exports = { runCli, parseArgs, HELP };
