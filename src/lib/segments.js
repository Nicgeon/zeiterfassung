'use strict';

// Echte Arbeitszeiträume eines Eintrags ("Teile"), z. B. bei einer unterbrochenen und später fortgesetzten Aufgabe
// [["10:35","11:05"],["12:35","13:05"]]. Der Zeitstrahl zeichnet diese Zeiträume; Start/Ende des Eintrags bleiben
// für Summen und Kopierzeilen wie bisher. null = keine echten Zeiten bekannt (z. B. nur Dauer eingegeben).

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_SEGMENTS = 50;

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const toHM = (total) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** Bereinigt eine Liste von Zeiträumen (sortiert, nur gültige, Ende nach Start); leere Liste -> null. */
function normalize(list) {
  if (!Array.isArray(list)) return null;
  const out = list
    .filter((s) => Array.isArray(s) && s.length === 2 && TIME_RE.test(s[0]) && TIME_RE.test(s[1]) && toMin(s[1]) > toMin(s[0]))
    .map((s) => [s[0], s[1]])
    .sort((a, b) => toMin(a[0]) - toMin(b[0]))
    .slice(0, MAX_SEGMENTS);
  return out.length ? out : null;
}

function parse(json) {
  if (!json) return null;
  try { return normalize(JSON.parse(json)); } catch { return null; }
}

function stringify(list) {
  const n = normalize(list);
  return n ? JSON.stringify(n) : null;
}

/** Ein Zeitraum von start bis end; endet er nicht nach dem Start, wird es eine Minute (direkt wieder gestoppt). */
function single(start, end) {
  if (!TIME_RE.test(start || '') || !TIME_RE.test(end || '')) return null;
  const s = toMin(start);
  let e = toMin(end);
  if (e <= s) e = Math.min(s + 1, 23 * 60 + 59);
  return e > s ? [[start, toHM(e)]] : null;
}

module.exports = { TIME_RE, normalize, parse, stringify, single, toMin, toHM };
