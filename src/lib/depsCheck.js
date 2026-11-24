'use strict';

// Stimmen die installierten Pakete (node_modules) mit der Paketliste (package-lock.json) überein?
// Wird vor jedem Start geprüft: Ein Update kann die Paketliste ändern, und wenn das Nachinstallieren danach nicht
// lief (abgebrochen, Fenster geschlossen, keine Verbindung), würde sonst neuer Code mit alten Paketen starten.
// Ohne Abhängigkeiten außer Node selbst, damit die Prüfung auch bei kaputtem node_modules läuft.
//
//   node src/lib/depsCheck.js   -> Ausgabe der Abweichungen, Exit-Code 1 bei Abweichung (für die Startskripte)

const fs = require('fs');
const path = require('path');

/** Liste der Abweichungen bei den direkten Abhängigkeiten: [{name, installed, expected}]; leer = alles passt. */
function dependencyMismatches(root = path.join(__dirname, '..', '..')) {
  let pkg;
  let lock;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  } catch {
    return []; // ohne Paketliste nichts zu prüfen
  }
  const out = [];
  for (const name of Object.keys(pkg.dependencies || {})) {
    const entry = lock.packages && lock.packages[`node_modules/${name}`];
    const expected = entry && entry.version;
    let installed = null;
    try { installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { /* fehlt */ }
    if (!installed || (expected && installed !== expected)) out.push({ name, installed, expected: expected || '?' });
  }
  return out;
}

if (require.main === module) {
  const list = dependencyMismatches();
  for (const m of list) console.log(`${m.name}: installiert ${m.installed || 'fehlt'}, erwartet ${m.expected}`); // eslint-disable-line no-console
  process.exit(list.length ? 1 : 0);
}

module.exports = { dependencyMismatches };
