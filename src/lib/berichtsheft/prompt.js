'use strict';

// Prompt, Antwortformat und Prüfung der KI-Antwort.

const SCHEMA = {
  type: 'object',
  properties: {
    zuordnung: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, block: { type: 'string', enum: ['betrieb', 'schule'] } },
        required: ['id', 'block'],
        additionalProperties: false,
      },
    },
    betrieb: { type: 'string' },
    schule: { type: 'string' },
  },
  required: ['zuordnung', 'betrieb', 'schule'],
  additionalProperties: false,
};

const MAX_LINES = 10;
const MIN_LINES = 5;

function systemPrompt({ lineWidth = 95 } = {}) {
  return `Du hilfst einem Auszubildenden in der Informatik beim Schreiben des wöchentlichen Ausbildungsnachweises (Berichtsheft). Du bekommst nummerierte Stichpunkte einer Woche. Sie sind bereits anonymisiert: Platzhalter wie "ein Kollege", "ein Kunde" und "ein Unternehmen" stehen für Namen.

Aufgabe 1 – Zuordnung: Ordne jeden Stichpunkt einem Block zu.
- "betrieb" = betriebliche Tätigkeit im Ausbildungsbetrieb.
- "schule" = Berufsschule bzw. Unterrichtsthema.
Hinweise in eckigen Klammern: [Schule: sicher] heißt, der Nutzer hat den Eintrag als Berufsschule markiert – er muss "schule" sein. [Stichwort Schule] ist nur ein Hinweis auf einen möglichen Schulbezug, entscheide selbst. Stichpunkte ohne erkennbaren Schulbezug sind "betrieb". Jede id kommt genau einmal in "zuordnung" vor.

Aufgabe 2 – Texte: Schreibe je Block einen zusammenhängenden Fließtext.
- Fließtext in ganzen Sätzen, KEINE Aufzählung, keine Spiegelstriche, keine Nummerierung, keine Zwischenüberschriften.
- Sachlicher Berichtsstil in der Vergangenheit, ohne "ich".
- Korrigiere Rechtschreibung und Grammatik.
- Fasse gleiche oder ähnliche Tätigkeiten zusammen. Füllwörter und Wiederholungen wie "dokumentiert", "aufgeräumt", "erledigt", "diverse" nennst du höchstens einmal.
- Keine Datums-, Uhrzeit- oder Wochentagsangaben, keine Ticketnummern.
- Verwende die Platzhalter ("ein Kunde", "ein Kollege", "ein Unternehmen") grammatisch passend weiter. Erfinde oder errate niemals Namen.
- Erfinde nichts: nur Inhalte aus den Stichpunkten. Programm- und Fachbegriffe (z. B. Lini) bleiben unverändert.
- Umfang: beide Texte zusammen ${MIN_LINES} bis ${MAX_LINES} Zeilen, eine Zeile hat etwa ${lineWidth} Zeichen (zusammen also höchstens etwa ${MAX_LINES * lineWidth} Zeichen). Reicht das Material nicht für ${MIN_LINES} Zeilen, schreibe lieber kürzer, statt etwas zu erfinden.
- Gibt es keine Schul-Stichpunkte, ist "schule" ein leerer String und "betrieb" darf bis zu ${MAX_LINES} Zeilen lang sein. Gibt es keine betrieblichen Stichpunkte, ist "betrieb" leer.

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt dieser Form, ohne weiteren Text:
{"zuordnung":[{"id":1,"block":"betrieb"}],"betrieb":"...","schule":"..."}`;
}

/** items: [{id, text, count, school, keyword}] -> Nutzernachricht */
function userMessage(items) {
  const lines = items.map((it) => {
    const tags = [];
    if (it.school) tags.push('[Schule: sicher]');
    else if (it.keyword) tags.push('[Stichwort Schule]');
    if (it.count > 1) tags.push(`(${it.count}x erfasst)`);
    return `${it.id}. ${it.text}${tags.length ? ' ' + tags.join(' ') : ''}`;
  });
  return `Stichpunkte der Woche:\n${lines.join('\n')}`;
}

/** Zeilen nach Umbruch bei width Zeichen (Wörter werden nicht getrennt). */
function countLines(text, width = 95) {
  const t = String(text || '').trim();
  if (!t) return 0;
  let lines = 0;
  for (const paragraph of t.split(/\n+/)) {
    let len = 0;
    lines += 1;
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (len === 0) len = word.length;
      else if (len + 1 + word.length <= width) len += 1 + word.length;
      else {
        lines += 1;
        len = word.length;
      }
    }
  }
  return lines;
}

function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('Die Antwort enthielt kein lesbares JSON.');
  }
}

/** Prüft Form und Zuordnung der Antwort; wirft bei unbrauchbarer Struktur. */
function parseAnswer(raw, items) {
  const data = typeof raw === 'string' ? extractJson(raw) : raw;
  if (!data || typeof data.betrieb !== 'string' || typeof data.schule !== 'string' || !Array.isArray(data.zuordnung)) {
    throw new Error('Die Antwort hat nicht das erwartete Format (zuordnung, betrieb, schule).');
  }
  const assignment = new Map();
  for (const z of data.zuordnung) {
    if (z && Number.isInteger(z.id) && (z.block === 'betrieb' || z.block === 'schule')) assignment.set(z.id, z.block);
  }
  // Sichere Schul-Markierungen gelten immer; fehlende Zuordnungen fallen auf "betrieb".
  for (const it of items) {
    if (it.school) assignment.set(it.id, 'schule');
    else if (!assignment.has(it.id)) assignment.set(it.id, 'betrieb');
  }
  return { betrieb: data.betrieb.trim(), schule: data.schule.trim(), assignment };
}

/** Liste von Problemen (leer = in Ordnung). "hard" = erneut anfragen. */
function checkLimits({ betrieb, schule }, { lineWidth = 95, hasSchool, hasBetrieb }) {
  const problems = [];
  const lines = countLines(betrieb, lineWidth) + countLines(schule, lineWidth);
  if (lines > MAX_LINES) problems.push({ hard: true, text: `Die Texte sind zusammen ${lines} Zeilen lang (höchstens ${MAX_LINES}).` });
  if (/^\s*([-*•]|\d+[.)])\s/m.test(betrieb + '\n' + schule)) {
    problems.push({ hard: true, text: 'Die Texte enthalten Aufzählungszeichen; gewünscht ist Fließtext.' });
  }
  if (hasBetrieb && !betrieb) problems.push({ hard: true, text: 'Der Betriebstext ist leer, obwohl betriebliche Stichpunkte vorliegen.' });
  if (hasSchool && !schule) problems.push({ hard: true, text: 'Der Schultext ist leer, obwohl Schul-Stichpunkte vorliegen.' });
  if (lines > 0 && lines < MIN_LINES) problems.push({ hard: false, text: `Die Texte sind zusammen nur ${lines} Zeilen lang (gewünscht ${MIN_LINES} bis ${MAX_LINES}).` });
  return { lines, problems };
}

module.exports = { SCHEMA, MAX_LINES, MIN_LINES, systemPrompt, userMessage, countLines, extractJson, parseAnswer, checkLimits };
