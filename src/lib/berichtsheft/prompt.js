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

/** Kurzfassung für kleine/langsame Modelle: weniger Eingabe, weniger Ausgabe (nur Nummern statt Zuordnungsliste). */
function compactPrompt({ lineWidth = 95 } = {}) {
  return `Du schreibst den wöchentlichen Ausbildungsnachweis eines IT-Azubis. Du bekommst nummerierte, anonymisierte Stichpunkte ("ein Kunde", "ein Kollege", "ein Unternehmen" sind Platzhalter für Namen).

1. "schule_ids": Nummern der Stichpunkte, die zur Berufsschule gehören ([Schule: sicher] immer, [Stichwort Schule] nur wenn es passt). Alle anderen sind betrieblich.
2. "betrieb" und "schule": je ein Fließtext aus vollständigen, gut lesbaren Sätzen (jeder Satz mit Subjekt und Verb), Vergangenheit, ohne "ich", keine Aufzählung. Satzbau abwechseln: nicht jeden Satz mit "wurde/wurden" beginnen, Sätze mit "außerdem", "anschließend", "dabei" verbinden, Aktiv und Passiv mischen. Rechtschreibung korrigieren, Gleiches nur einmal nennen, nichts erfinden. Keine Namen, Daten, Wochentage, Uhrzeiten ("Am Montag", "letzte Woche") oder Ticketnummern. Programmnamen (z. B. Lini) unverändert lassen.
3. Zusammen ${MIN_LINES} bis ${MAX_LINES} Zeilen (je ca. ${lineWidth} Zeichen, höchstens etwa ${MAX_LINES * lineWidth} Zeichen). Wenig Material: lieber kürzer. Keine Schul-Stichpunkte: "schule" ist "".

Antworte nur mit einem einzelnen JSON-Objekt (kein Array, kein weiterer Text), genau in dieser Form: {"schule_ids":[],"betrieb":"","schule":""}`;
}

function systemPrompt({ lineWidth = 95, compact = false } = {}) {
  if (compact) return compactPrompt({ lineWidth });
  return `Du hilfst einem Auszubildenden in der Informatik beim Schreiben des wöchentlichen Ausbildungsnachweises (Berichtsheft). Du bekommst nummerierte Stichpunkte einer Woche. Sie sind bereits anonymisiert: Platzhalter wie "ein Kollege", "ein Kunde" und "ein Unternehmen" stehen für Namen.

Aufgabe 1 – Zuordnung: Ordne jeden Stichpunkt einem Block zu.
- "betrieb" = betriebliche Tätigkeit im Ausbildungsbetrieb.
- "schule" = Berufsschule bzw. Unterrichtsthema.
Hinweise in eckigen Klammern: [Schule: sicher] heißt, der Nutzer hat den Eintrag als Berufsschule markiert – er muss "schule" sein. [Stichwort Schule] ist nur ein Hinweis auf einen möglichen Schulbezug, entscheide selbst. Stichpunkte ohne erkennbaren Schulbezug sind "betrieb". Jede id kommt genau einmal in "zuordnung" vor.

Aufgabe 2 – Texte: Schreibe je Block einen zusammenhängenden Fließtext.
- Fließtext in ganzen Sätzen, KEINE Aufzählung, keine Spiegelstriche, keine Nummerierung, keine Zwischenüberschriften.
- Sachlicher Berichtsstil in der Vergangenheit, ohne "ich". Abwechslungsreicher Satzbau: nicht jeder Satz mit "wurde/wurden", Sätze mit "außerdem", "anschließend", "dabei", "darüber hinaus" verbinden, Aktiv und Passiv mischen (z. B. "Zu den Aufgaben gehörten …", "Unterstützt wurde …").
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
    const a = t.search(/[{[]/);
    const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('Die Antwort enthielt kein lesbares JSON.');
  }
}

/**
 * Macht aus kleinen Abweichungen der Modelle das erwartete Objekt:
 *  - Array mit einem oder mehreren Objekten ([{...}] bzw. [{"schule_ids":..},{"betrieb":..}]) -> ein Objekt
 *  - fehlendes oder leeres ("null") "schule" -> ""  (so steht es im Prompt für "keine Schul-Stichpunkte")
 *  - "schule_ids" als Zahl oder Text ("3" bzw. "3, 4") -> Liste
 * Alles andere bleibt unverändert und wird von parseAnswer abgelehnt.
 */
function normalizeAnswer(data) {
  let obj = data;
  if (Array.isArray(obj)) {
    const parts = obj.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    obj = parts.length ? Object.assign({}, ...parts) : obj;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  if (out.schule === undefined || out.schule === null) {
    if (typeof out.betrieb === 'string' && (Array.isArray(out.zuordnung) || out.schule_ids !== undefined)) out.schule = '';
  }
  if (out.schule_ids !== undefined && !Array.isArray(out.schule_ids)) {
    if (typeof out.schule_ids === 'number') out.schule_ids = [out.schule_ids];
    else if (typeof out.schule_ids === 'string' && /^[\d\s,;]*$/.test(out.schule_ids)) {
      out.schule_ids = out.schule_ids.split(/[\s,;]+/).filter(Boolean).map(Number);
    }
  }
  return out;
}

/** Prüft Form und Zuordnung der Antwort; wirft bei unbrauchbarer Struktur. */
function parseAnswer(raw, items) {
  const data = normalizeAnswer(typeof raw === 'string' ? extractJson(raw) : raw);
  const hasList = data && Array.isArray(data.zuordnung);
  const hasIds = data && Array.isArray(data.schule_ids);
  if (!data || typeof data.betrieb !== 'string' || typeof data.schule !== 'string' || !(hasList || hasIds)) {
    throw new Error('Die Antwort hat nicht das erwartete Format (zuordnung oder schule_ids, betrieb, schule).');
  }
  const assignment = new Map();
  if (hasList) {
    for (const z of data.zuordnung) {
      if (z && Number.isInteger(z.id) && (z.block === 'betrieb' || z.block === 'schule')) assignment.set(z.id, z.block);
    }
  } else {
    // Kurzform: genannte Nummern = Schule, alle anderen Betrieb
    const school = new Set(data.schule_ids.map(Number).filter(Number.isInteger));
    for (const it of items) assignment.set(it.id, school.has(it.id) ? 'schule' : 'betrieb');
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

module.exports = { SCHEMA, MAX_LINES, MIN_LINES, systemPrompt, compactPrompt, userMessage, countLines, extractJson, normalizeAnswer, parseAnswer, checkLimits };

// ---------------------------------------------------------------------------------------------
// Schrittweise Aufgaben fuer kleine Modelle (Noah AI, eigene Adressen): statt EINER Anfrage mit
// JSON-Antwort mehrere kleine Anfragen mit einfacher Antwort - (1) welche Stichpunkte sind Schule,
// (2) Fliesstext Betrieb, (3) Fliesstext Schule. Freie Texte lassen sich nicht "im falschen Format"
// liefern, und jede Aufgabe ist fuer sich klein genug.
// ---------------------------------------------------------------------------------------------

function classifyPrompt() {
  return `Du ordnest Stichpunkte eines IT-Azubis ein. Nenne die Nummern der Stichpunkte, die zur Berufsschule gehören (Unterricht, Lernfelder, Schulthemen, Klassenarbeiten). [Schule: sicher] gehört immer dazu, [Stichwort Schule] nur, wenn es wirklich um Unterricht geht. Alle anderen Stichpunkte sind betriebliche Tätigkeiten und werden NICHT genannt.

Antworte NUR mit den Nummern, durch Komma getrennt (zum Beispiel: 4, 7, 12). Gibt es keinen Schul-Stichpunkt, antworte mit: keine`;
}

const SECTIONS = {
  betrieb: { title: 'Betriebliche Tätigkeiten', what: 'die betrieblichen Tätigkeiten der Woche' },
  schule: { title: 'Berufsschule (Unterrichtsthemen)', what: 'die behandelten Unterrichtsthemen in der Berufsschule' },
};

/** Prompt für einen Textabschnitt; maxLines = Zeilenbudget dieses Abschnitts. */
function writePrompt(section, { maxLines = MAX_LINES, lineWidth = 95 } = {}) {
  const s = SECTIONS[section];
  return `Du schreibst einen Abschnitt des wöchentlichen Ausbildungsnachweises eines IT-Azubis: ${s.what}. Du bekommst nummerierte, anonymisierte Stichpunkte ("ein Kunde", "ein Kollege", "ein Unternehmen" sind Platzhalter für Namen).

Schreibe daraus EINEN zusammenhängenden Fließtext aus vollständigen, gut lesbaren Sätzen (jeder Satz mit Subjekt und Verb) in der Vergangenheit, ohne "ich", ohne Aufzählung. Wechsle den Satzbau ab (nicht jeden Satz mit "wurde/wurden" beginnen, Sätze mit "außerdem", "anschließend", "dabei" verbinden, Aktiv und Passiv mischen). Fasse Gleiches zusammen, nenne Wichtiges zuerst, erfinde nichts. Keine Namen, Daten, Wochentage, Uhrzeiten ("Am Montag", "letzte Woche") oder Ticketnummern. Programmnamen (z. B. Lini) unverändert lassen.

Umfang: höchstens ${maxLines} Zeilen zu je etwa ${lineWidth} Zeichen (also höchstens etwa ${maxLines * lineWidth} Zeichen). Bei vielen Stichpunkten fasse stark zusammen.

Antworte NUR mit dem Text: ohne Überschrift, ohne Anführungszeichen, ohne Nummerierung, ohne JSON.`;
}

/** Nummern aus der Antwort des Einordnungsschritts; null = Antwort unbrauchbar. */
function parseIdList(text, items) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^\W*(keine|kein|none|nichts|niemand)\b/i.test(t) && !/\d/.test(t)) return [];
  const known = new Set(items.map((i) => i.id));
  const ids = [...new Set((t.match(/\d+/g) || []).map(Number).filter((n) => known.has(n)))];
  if (!ids.length) return /keine/i.test(t) ? [] : null;
  // Wer (fast) alles nennt, hat die Aufgabe nicht verstanden (z. B. einfach "1, 2, 3, ... 86")
  if (items.length >= 4 && ids.length > items.length * 0.8) return null;
  return ids;
}

/**
 * Bringt eine freie Modellantwort in die Form "ein Absatz Fliesstext": entfernt Code-Zaeune,
 * Anfuehrungszeichen, Ueberschriften ("Betriebliche Tätigkeiten:"), Aufzaehlungszeichen und
 * packt versehentliches JSON aus ({"betrieb":"..."} bzw. ["...","..."]).
 */
function cleanProse(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
  if (/^[[{]/.test(t)) {
    try {
      const strings = [];
      const walk = (v) => {
        if (typeof v === 'string') strings.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(JSON.parse(t));
      if (strings.length) t = strings.join(' ');
    } catch { /* kein JSON: Text so lassen */ }
  }
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^(?:#+\s*)?(?:\*\*)?(Betriebliche T(?:ä|ae)tigkeiten|Berufsschule(?: \(Unterrichtsthemen\))?|Betrieb|Schule)(?:\*\*)?:?$/i.test(l))
    .map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/^\*\*|\*\*$/g, '').replace(/^["„“'»«]+|["“”'»«]+$/g, '').trim())
    .map((l) => (/[.!?:;]$/.test(l) ? l : `${l}.`));
  t = lines.join(' ')
    .replace(/^(?:Betriebliche T(?:ä|ae)tigkeiten|Berufsschule(?: \(Unterrichtsthemen\))?)\s*:\s*/i, '')
    .replace(/^["„“'»«]+|["“”'»«]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t;
}

/** Kuerzt am Satzende, bis der Text in maxLines Zeilen passt (mindestens ein Satz bleibt). */
function truncateToLines(text, maxLines, width = 95) {
  if (countLines(text, width) <= maxLines) return { text, cut: false };
  const sentences = String(text).match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [text];
  const kept = [...sentences];
  while (kept.length > 1 && countLines(kept.join('').trim(), width) > maxLines) kept.pop();
  return { text: kept.join('').trim(), cut: true };
}

module.exports.classifyPrompt = classifyPrompt;
module.exports.writePrompt = writePrompt;
module.exports.parseIdList = parseIdList;
module.exports.cleanProse = cleanProse;
module.exports.truncateToLines = truncateToLines;
