'use strict';

// Hinweis auf eine veraltete Node.js-Version (lokaler Betrieb, Einstellungen → Programm & Updates). Node.js schließt
// Sicherheitslücken in neuen Versionen jeder Reihe; die Liste wird mit den Updates der Zeiterfassung nachgeführt.

// Erste Version jeder Reihe mit allen bekannten Sicherheitskorrekturen (Stand: Node.js-Sicherheitsupdate 11.11.2026)
const PATCHED = { 22: '22.23.5', 24: '24.22.3', 26: '26.13.1' };
const MIN_MAJOR = 22;

const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** {version, outdated, recommended, text} für die installierte (oder eine angegebene) Version. */
function nodeAdvice(version = process.versions.node) {
  const [major] = parse(version);
  if (major < MIN_MAJOR) {
    return { version, outdated: true, recommended: PATCHED[24], text: `Node.js ${version} wird nicht mehr unterstützt und bekommt keine Sicherheitskorrekturen. Bitte Node.js ${PATCHED[24]} oder neuer installieren.` };
  }
  const patched = PATCHED[major];
  if (!patched) {
    // Reihen ohne Eintrag: ungerade (kurzlebige) Reihen sind nach kurzer Zeit ohne Korrekturen
    if (major % 2 === 1) return { version, outdated: true, recommended: PATCHED[24], text: `Node.js ${major} ist eine kurzlebige Reihe ohne langfristige Sicherheitskorrekturen. Empfohlen: Node.js ${PATCHED[24]} oder neuer.` };
    return { version, outdated: false, recommended: null, text: '' };
  }
  if (compare(version, patched) < 0) {
    return { version, outdated: true, recommended: patched, text: `Node.js ${version} hat bekannte Sicherheitslücken. Bitte auf ${patched} oder neuer aktualisieren.` };
  }
  return { version, outdated: false, recommended: null, text: '' };
}

module.exports = { nodeAdvice, PATCHED, compare };
