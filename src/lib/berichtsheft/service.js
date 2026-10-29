'use strict';

// Gemeinsame Logik fuer die Weboberflaeche (src/routes/berichtsheft.js): Vorschau der anonymisierten
// Stichpunkte, Klaeren unbekannter Woerter, Erzeugen des Textes. Nichts davon rechnet mit
// Client-Texten - es wird immer aus den gespeicherten Eintraegen neu aufgebaut, damit die Vorschau
// exakt dem entspricht, was gesendet wird (Pruefsumme "hash").

const crypto = require('crypto');
const { resolvePeriod, periodLabel } = require('./period');
const { findCandidates, findUnreviewedWords, scrubOutput, KINDS } = require('./anonymize');
const { buildItems, localReport, aiReport } = require('./pipeline');
const { PROVIDERS, resolveKey, resolveModel } = require('./store');
const { formatReport, lineSummary } = require('./report');

class ServiceError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const vocabOf = (config) => ({ names: config.names, allow: config.allow });

/** Einstellungen fuer Anzeige und Wahl des Anbieters; Schluessel selbst werden nie herausgegeben. */
function describeSettings(config, { env = process.env, aiAllowed = true, customUrlAllowed = false } = {}) {
  return {
    aiAllowed,
    customUrlAllowed,
    provider: config.provider,
    providers: Object.entries(PROVIDERS)
      .filter(([id]) => id !== 'kompatibel' || customUrlAllowed)
      .map(([id, p]) => ({
        id,
        label: p.label,
        defaultModel: p.defaultModel,
        model: (config.models && config.models[id]) || '',
        hasKey: !!(config.keys && config.keys[id]),
        hasEnvKey: p.env.some((name) => !!env[name]),
        baseUrl: (config.baseUrls && config.baseUrls[id]) || '',
      })),
    keywords: config.keywords,
    names: config.names,
    allow: config.allow,
  };
}

function cleanTerm(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Prueft und uebernimmt Einstellungen aus einer Anfrage (teilweise Aktualisierung erlaubt). */
function applySettings(config, body, { customUrlAllowed = false } = {}) {
  const next = { ...config, models: { ...config.models }, keys: { ...config.keys }, baseUrls: { ...config.baseUrls } };
  const b = body || {};
  if (b.provider !== undefined) {
    if (!PROVIDERS[b.provider]) throw new ServiceError('Unbekannter Anbieter.');
    if (b.provider === 'kompatibel' && !customUrlAllowed) {
      throw new ServiceError('Eigene Adressen sind auf diesem Server nicht erlaubt (BERICHTSHEFT_ALLOW_CUSTOM_URL=true setzen).', 403);
    }
    next.provider = b.provider;
  }
  const target = b.provider || next.provider;
  if (b.model !== undefined) next.models[target] = String(b.model || '').trim().slice(0, 120);
  if (b.apiKey) {
    const key = String(b.apiKey).trim();
    if (key.length < 8 || key.length > 400 || /\s/.test(key)) throw new ServiceError('Der API-Schlüssel sieht ungültig aus.');
    next.keys[target] = key;
  }
  if (b.clearKey) delete next.keys[target];
  if (b.baseUrl !== undefined) {
    const url = String(b.baseUrl || '').trim();
    if (url && target !== 'kompatibel') throw new ServiceError('Eine eigene Adresse gibt es nur beim Anbieter "OpenAI-kompatibel".');
    if (url && !customUrlAllowed) throw new ServiceError('Eigene Adressen sind auf diesem Server nicht erlaubt.', 403);
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new ServiceError('Die Adresse muss mit http:// oder https:// beginnen.');
    next.baseUrls[target] = url.slice(0, 300);
  }
  if (b.keywords !== undefined) {
    if (!Array.isArray(b.keywords) || b.keywords.length > 30) throw new ServiceError('Ungültige Stichwörter.');
    next.keywords = [...new Set(b.keywords.map(cleanTerm).filter(Boolean))];
  }
  if (b.names !== undefined) {
    if (!Array.isArray(b.names) || b.names.length > 500) throw new ServiceError('Ungültige Namensliste.');
    const seen = new Set();
    next.names = [];
    for (const n of b.names) {
      const term = cleanTerm(n && n.term);
      if (!term || !n || !KINDS.includes(n.kind)) throw new ServiceError('Jeder Name braucht einen Begriff und eine Art (person, kunde, firma).');
      if (seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      next.names.push({ term, kind: n.kind });
    }
  }
  if (b.allow !== undefined) {
    if (!Array.isArray(b.allow) || b.allow.length > 500) throw new ServiceError('Ungültige Erlaubnisliste.');
    next.allow = [...new Set(b.allow.map(cleanTerm).filter(Boolean))];
  }
  return next;
}

/** Nimmt Entscheidungen zu unbekannten Woertern auf. decisions: [{word, kind}]; kind = person|kunde|firma|begriff|harmlos */
function applyReview(config, decisions, extraNames = []) {
  const next = { ...config, names: [...config.names], allow: [...config.allow], reviewed: [...(config.reviewed || [])] };
  const addName = (term, kind) => {
    const t = cleanTerm(term);
    if (!t) return;
    next.allow = next.allow.filter((a) => a.toLowerCase() !== t.toLowerCase());
    const existing = next.names.find((n) => n.term.toLowerCase() === t.toLowerCase());
    if (existing) existing.kind = kind;
    else next.names.push({ term: t, kind });
  };
  for (const d of decisions || []) {
    const word = cleanTerm(d && d.word);
    if (!word) continue;
    if (KINDS.includes(d.kind)) addName(word, d.kind);
    else if (d.kind === 'begriff') {
      if (!next.allow.some((a) => a.toLowerCase() === word.toLowerCase())) next.allow.push(word);
      next.names = next.names.filter((n) => n.term.toLowerCase() !== word.toLowerCase());
    } else if (d.kind === 'harmlos') next.reviewed.push(word.toLowerCase());
    else throw new ServiceError(`Unbekannte Entscheidung "${d.kind}" für "${word}".`);
  }
  for (const n of extraNames || []) {
    if (!n || !KINDS.includes(n.kind)) throw new ServiceError('Jeder ergänzte Name braucht eine Art (person, kunde, firma).');
    addName(n.term, n.kind);
  }
  next.reviewed = [...new Set(next.reviewed)];
  return next;
}

function providerChoice(config, env, flags = {}) {
  const { aiAllowed = true, customUrlAllowed = false } = flags;
  const provider = config.provider;
  const model = resolveModel(config, provider);
  const apiKey = resolveKey(config, provider, env);
  const usable = aiAllowed && (provider !== 'kompatibel' || customUrlAllowed) && (!!apiKey || provider === 'kompatibel');
  return { provider, model, apiKey, usable, label: PROVIDERS[provider].label, baseUrl: config.baseUrls[provider] };
}

/**
 * Vorschau: anonymisierte Stichpunkte, was ersetzt wurde und welche Woerter noch geklaert werden muessen.
 */
function prepare({ store, userId, from, to, env = process.env, flags = {} }) {
  const config = store.loadConfig(userId);
  const period = resolvePeriod({ von: from, bis: to });
  const entries = store.loadEntries(userId, period.from, period.to);
  const built = buildItems(entries, vocabOf(config), config.keywords);
  const texts = built.items.map((i) => i.text);

  const strong = new Map();
  for (const t of texts) {
    for (const c of findCandidates(t, vocabOf(config))) {
      if (!strong.has(c.word) && !config.reviewed.includes(c.word.toLowerCase())) strong.set(c.word, c.reason);
    }
  }
  const covered = new Set([...strong.keys()].flatMap((w) => w.toLowerCase().split(/\s+/)));
  const weak = [...new Set(texts.flatMap((t) => findUnreviewedWords(t, vocabOf(config), config.reviewed)))]
    .filter((w) => !covered.has(w.toLowerCase()));
  const pending = [
    ...[...strong].map(([word, reason]) => ({ word, reason, strong: true })),
    ...weak.map((word) => ({ word, reason: 'noch nicht geprüft', strong: false })),
  ];

  const choice = providerChoice(config, env, flags);
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify([built.items.map((i) => [i.id, i.text, i.school, i.keyword, i.count]), choice.provider, choice.model]))
    .digest('hex').slice(0, 32);

  const replacedCounts = new Map();
  for (const r of built.replaced) {
    const key = `${r.from.trim()}|${r.kind}`;
    replacedCounts.set(key, (replacedCounts.get(key) || 0) + 1);
  }
  return {
    period,
    label: periodLabel(period),
    entryCount: entries.length,
    items: built.items.map((i) => ({ id: i.id, text: i.text, count: i.count, school: i.school, keyword: i.keyword })),
    replaced: [...replacedCounts].map(([k, count]) => ({ from: k.split('|')[0], kind: k.split('|')[1], count })),
    pending,
    hash,
    ai: { provider: choice.provider, label: choice.label, model: choice.model, usable: choice.usable, hasKey: !!choice.apiKey, allowed: flags.aiAllowed !== false },
  };
}

/**
 * Text erzeugen. Verweigert, solange Woerter ungeklaert sind oder die Vorschau veraltet ist.
 */
async function generate({ store, userId, from, to, hash, mode, env = process.env, flags = {}, generateImpl, onRetry }) {
  const prep = prepare({ store, userId, from, to, env, flags });
  if (!prep.items.length) throw new ServiceError('In diesem Zeitraum gibt es keine Einträge mit Text.', 404);
  if (prep.pending.length) throw new ServiceError('Es gibt noch ungeklärte Wörter – bitte zuerst die Vorschau prüfen.', 409, { pending: prep.pending });
  if (!hash || hash !== prep.hash) throw new ServiceError('Die Vorschau ist veraltet. Bitte erneut „Vorschau erstellen“ wählen.', 409, { stale: true });

  const config = store.loadConfig(userId);
  const built = buildItems(store.loadEntries(userId, prep.period.from, prep.period.to), vocabOf(config), config.keywords);
  let result;
  if (mode === 'lokal') {
    result = { ...localReport(built.items), problems: [] };
  } else {
    const choice = providerChoice(config, env, flags);
    if (flags.aiAllowed === false) throw new ServiceError('Externe KI-Anbieter sind auf diesem Server abgeschaltet.', 403);
    if (!choice.usable) throw new ServiceError(`Für ${choice.label} ist noch kein API-Schlüssel hinterlegt (Konto → Berichtsheft-KI).`, 400);
    result = await aiReport({
      items: built.items, provider: choice.provider, model: choice.model, apiKey: choice.apiKey,
      baseUrl: choice.baseUrl, lineWidth: config.lineWidth, generateImpl, onRetry,
    });
  }
  const work = scrubOutput(result.betrieb, vocabOf(config));
  const school = scrubOutput(result.schule, vocabOf(config));
  const warnings = result.problems.map((p) => p.text);
  if (work.changed || school.changed) warnings.push('Im Ergebnis standen noch Namen, Daten oder Ticketnummern – sie wurden entfernt. Bitte den Text prüfen.');
  const final = { betrieb: work.text, schule: school.text };
  return {
    ...final,
    text: formatReport(final),
    lines: lineSummary(final, config.lineWidth),
    warnings,
    assignment: built.items.map((i) => ({ id: i.id, text: i.text, block: result.assignment.get(i.id) === 'schule' ? 'schule' : 'betrieb' })),
    label: prep.label,
    mode: mode === 'lokal' ? 'lokal' : 'ki',
  };
}

module.exports = { ServiceError, describeSettings, applySettings, applyReview, prepare, generate };
