'use strict';

// Diagnose-Ausgaben für den Berichtsheft-Text (stderr, im Terminal der App bzw. des Befehls).
//
//   BERICHTSHEFT_DEBUG=1      Anfrage-Eckdaten, Antwortstatus, Zeiten, Datenstrom-Statistik, Hinweise
//   BERICHTSHEFT_DEBUG=voll   zusätzlich kompletter Prompt und komplette Rohantwort (enthält den
//                             anonymisierten Text, nie den API-Schlüssel)
//   (ohne)                    nur je eine Zeile pro Anfrage (Erfolg/Fehler) und Warnungen
//   BERICHTSHEFT_DEBUG=aus    gar keine Ausgabe
//   BERICHTSHEFT_STREAM=aus   (Noah AI/eigene Adresse) nie als Datenstrom anfragen
//
// Auf der Kommandozeile: --debug bzw. --debug-voll.

function level(env = process.env) {
  const v = String(env.BERICHTSHEFT_DEBUG || '').trim().toLowerCase();
  if (v === 'aus') return -1; // vollstaendig still (Tests)
  if (v === 'voll' || v === '2') return 2;
  if (v && !['0', 'false', 'nein'].includes(v)) return 1;
  return 0;
}

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

/** Schreibt, wenn die Stufe erreicht ist (0 = immer). */
function log(minLevel, message, env = process.env) {
  if (level(env) < minLevel) return;
  // eslint-disable-next-line no-console
  console.error(`[berichtsheft ${stamp()}] ${message}`);
}

/** Kürzt lange Texte für die Ausgabe (einzeilig). */
function snippet(text, max = 400) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)} … (+${one.length - max} Zeichen)` : one;
}

function secs(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

module.exports = { level, log, snippet, secs };
