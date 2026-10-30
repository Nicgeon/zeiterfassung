'use strict';

// Von den Eintraegen zu anonymisierten Stichpunkten und zurueck zum fertigen Text.

const { anonymizeText } = require('./anonymize');
const { systemPrompt, userMessage, parseAnswer, checkLimits } = require('./prompt');
const { generate } = require('./providers');

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
async function aiReport({ items, provider, model, apiKey, baseUrl, lineWidth = 95, generateImpl = generate, onRetry }) {
  // Kleine, selbst gehostete Modelle bekommen den kurzen Prompt (schneller, weniger Ausgabe)
  const system = systemPrompt({ lineWidth, compact: COMPACT_PROVIDERS.has(provider) });
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
    }
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
