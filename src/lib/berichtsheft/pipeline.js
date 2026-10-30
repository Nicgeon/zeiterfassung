'use strict';

// Von den Eintraegen zu anonymisierten Stichpunkten und zurueck zum fertigen Text.

const { anonymizeText } = require('./anonymize');
const {
  systemPrompt, userMessage, parseAnswer, checkLimits, MAX_LINES,
  classifyPrompt, writePrompt, parseIdList, cleanProse, truncateToLines,
} = require('./prompt');
const { generate } = require('./providers');
const { log, snippet } = require('./debug');

const COMPACT_PROVIDERS = new Set(['noah', 'kompatibel']);
const TICKET_ONLY_TEXT = 'Bearbeitung eines Tickets';

function matchesKeyword(text, keywords) {
  const t = String(text || '').toLowerCase();
  return (keywords || []).some((k) => k && t.includes(String(k).toLowerCase()));
}

/**
 * Anonymisiert die Eintraege und fasst gleiche Texte zusammen.
 * @returns {{items: {id:number,text:string,count:number,minutes:number,school:boolean,keyword:boolean}[], replaced: object[]}}
 */
function buildItems(entries, vocab, keywords) {
  const byText = new Map();
  const items = [];
  const replaced = [];
  for (const e of entries) {
    const description = (e.description || '').trim();
    if (!description && !e.jiraKey) continue;
    const r = anonymizeText(description, vocab, { ownKeys: e.jiraKey ? [e.jiraKey] : [] });
    replaced.push(...r.replaced);
    const text = r.text || TICKET_ONLY_TEXT;
    const mapKey = text.toLowerCase();
    let item = byText.get(mapKey);
    if (!item) {
      item = { id: items.length + 1, text, count: 0, minutes: 0, school: false, keyword: false };
      byText.set(mapKey, item);
      items.push(item);
    }
    item.count += 1;
    item.minutes += e.minutes || 0;
    item.school = item.school || !!e.school;
    item.keyword = item.keyword || matchesKeyword(description, keywords);
  }
  return { items, replaced };
}

/** Text ohne KI: nur nach Markierung/Stichwort aufgeteilt und zu je einem Satz zusammengefasst. */
function localReport(items) {
  const school = items.filter((i) => i.school || i.keyword);
  const work = items.filter((i) => !(i.school || i.keyword));
  const sentence = (list, lead) => (list.length ? `${lead} ${list.map((i) => i.text).join('; ')}.` : '');
  return {
    betrieb: sentence(work, 'Es wurden folgende Tätigkeiten durchgeführt:'),
    schule: sentence(school, 'Behandelte Unterrichtsthemen:'),
    assignment: new Map(items.map((i) => [i.id, i.school || i.keyword ? 'schule' : 'betrieb'])),
  };
}

/**
 * Fragt den Anbieter und prüft die Antwort; bei harten Verstößen (zu lang, Aufzählung ...) gibt es
 * genau einen weiteren Versuch mit Rückmeldung.
 */
/**
 * Kleine Modelle (Noah AI, eigene Adressen) bekommen keine "JSON mit allem"-Aufgabe, sondern drei
 * einfache: (1) Nummern der Schul-Stichpunkte nennen, (2) Fließtext Betrieb, (3) Fließtext Schule.
 * Beide Texte sind freie Antworten (kein JSON) und werden nur aufgeräumt, nicht "geparst".
 */
async function stepwiseReport({ items, provider, model, apiKey, baseUrl, lineWidth = 95, generateImpl = generate, onRetry, onStep }) {
  const call = (system, user, maxTokens) => generateImpl({ provider, model, apiKey, baseUrl, system, user, format: 'text', maxTokens });
  const step = (text) => (onStep ? onStep(text) : log(0, text));
  const problems = [];

  // 1) Einordnung (kurze Antwort: nur Nummern). Unbrauchbar -> Markierung und Stichwörter entscheiden.
  const hinted = new Set(items.filter((i) => i.school || i.keyword).map((i) => i.id));
  let schoolIds;
  step(`Schritt 1/3: ${items.length} Stichpunkte einordnen (Berufsschule oder Betrieb) …`);
  const rawIds = await call(classifyPrompt(), userMessage(items), 600);
  const ids = parseIdList(stripForParse(rawIds), items);
  if (ids === null) {
    log(0, `Einordnung nicht lesbar, Antwort: ${snippet(rawIds, 200)} – verwende Markierungen und Stichwörter.`);
    problems.push({ hard: false, text: 'Die KI konnte die Stichpunkte nicht einordnen; es zählen nur Haken „Berufsschule“ und Stichwörter.' });
    schoolIds = hinted;
  } else {
    schoolIds = new Set(ids);
  }
  for (const it of items) if (it.school) schoolIds.add(it.id);

  const schoolItems = items.filter((i) => schoolIds.has(i.id));
  const workItems = items.filter((i) => !schoolIds.has(i.id));
  const assignment = new Map(items.map((i) => [i.id, schoolIds.has(i.id) ? 'schule' : 'betrieb']));

  // Zeilenbudget: zusammen höchstens 10 Zeilen, die Schule bekommt 2 bis 4 davon
  const both = schoolItems.length > 0 && workItems.length > 0;
  const schoolLines = both ? Math.min(4, Math.max(2, Math.round((MAX_LINES * schoolItems.length) / items.length))) : MAX_LINES;
  const workLines = both ? MAX_LINES - schoolLines : MAX_LINES;

  async function write(section, list, maxLines, label) {
    if (!list.length) return '';
    // ohne Hinweis-Markierungen und mit neu durchnummeriert: nur der Inhalt zählt
    const plain = list.map((it, i) => ({ ...it, id: i + 1, school: false, keyword: false }));
    const system = writePrompt(section, { maxLines, lineWidth });
    let user = userMessage(plain);
    for (let attempt = 1; attempt <= 2; attempt++) {
      step(`${label}: Text für ${list.length} Stichpunkt${list.length === 1 ? '' : 'e'} schreiben${attempt > 1 ? ' (zweiter Versuch)' : ''} …`);
      const raw = await call(system, user, 6000);
      const text = cleanProse(raw);
      log(1, `Rohtext (${section}): ${snippet(raw, 300)}`);
      if (text) {
        const cut = truncateToLines(text, maxLines, lineWidth);
        if (cut.cut) problems.push({ hard: false, text: `Der Text „${SECTION_NAME[section]}“ war zu lang und wurde auf ${maxLines} Zeilen gekürzt.` });
        return cut.text;
      }
      if (attempt === 1) {
        if (onRetry) onRetry(['Die Antwort war leer.']);
        user = `${userMessage(plain)}\n\nDeine letzte Antwort war leer. Bitte schreibe den Fließtext.`;
      }
    }
    throw new Error(`Die KI hat für „${SECTION_NAME[section]}“ keinen Text geliefert.`);
  }

  const betrieb = await write('betrieb', workItems, workLines, 'Schritt 2/3');
  const schule = await write('schule', schoolItems, schoolLines, 'Schritt 3/3');
  const { problems: limits } = checkLimits({ betrieb, schule }, { lineWidth, hasSchool: schoolItems.length > 0, hasBetrieb: workItems.length > 0 });
  return { betrieb, schule, assignment, problems: [...problems, ...limits] };
}

const SECTION_NAME = { betrieb: 'Betriebliche Tätigkeiten', schule: 'Berufsschule' };

/** Denkblock und Anführungszeichen weg, bevor Nummern gelesen werden (die Einordnung ist reiner Text). */
function stripForParse(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function aiReport({ items, provider, model, apiKey, baseUrl, lineWidth = 95, generateImpl = generate, onRetry, onStep }) {
  if (COMPACT_PROVIDERS.has(provider)) {
    return stepwiseReport({ items, provider, model, apiKey, baseUrl, lineWidth, generateImpl, onRetry, onStep });
  }
  const system = systemPrompt({ lineWidth });
  let user = userMessage(items);
  const hasSchool = items.some((i) => i.school);
  const hasBetrieb = items.some((i) => !i.school);
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await generateImpl({ provider, model, apiKey, baseUrl, system, user });
    let parsed;
    let problems;
    try {
      parsed = parseAnswer(raw, items);
      ({ problems } = checkLimits(parsed, { lineWidth, hasSchool, hasBetrieb: hasBetrieb && [...parsed.assignment.values()].includes('betrieb') }));
    } catch (err) {
      problems = [{ hard: true, text: err.message }];
      log(0, `Antwort nicht lesbar (Versuch ${attempt}): ${err.message} | Anfang der Antwort: ${snippet(raw, 300)}`);
    }
    if (problems.length) log(attempt === 1 ? 0 : 1, `Prüfung der Antwort (Versuch ${attempt}): ${problems.map((p) => `${p.hard ? 'HART' : 'weich'}: ${p.text}`).join(' | ')}`);
    last = { parsed, problems };
    const hard = problems.filter((p) => p.hard);
    if (!hard.length) break;
    if (attempt === 1) {
      if (onRetry) onRetry(hard.map((p) => p.text));
      user = `${userMessage(items)}\n\nDeine letzte Antwort war nicht in Ordnung: ${hard.map((p) => p.text).join(' ')} Bitte korrigiere das und antworte erneut nur mit dem JSON.`;
    }
  }
  if (!last.parsed) throw new Error(`Die KI-Antwort war unbrauchbar: ${last.problems.map((p) => p.text).join(' ')}`);
  return { ...last.parsed, problems: last.problems };
}

module.exports = { buildItems, localReport, aiReport, matchesKeyword, TICKET_ONLY_TEXT };
