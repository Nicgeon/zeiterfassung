'use strict';

// App-Fenster ohne Tabs und Adressleiste (Edge/Chrome/Brave mit eigenem Profil) fuer den lokalen Betrieb.
// Wird vom Server benutzt, wenn er den Browser selbst oeffnen soll (start-local.*), damit auch dort nie ein
// neuer Tab im normalen Browserfenster entsteht. Der Starter (src/launcher.js) nutzt dieselben Bausteine.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { listBrowsers, defaultBrowserKind, appWindowArgs } = require('./launcherUtil');

function readSettings(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'launcher.json'), 'utf8')); } catch { return {}; }
}

function which(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout : '';
}

/** Alle brauchbaren Browser in der Reihenfolge, in der sie versucht werden sollen. */
function findBrowsers(dataDir, env = process.env) {
  return listBrowsers({
    env,
    home: os.homedir(),
    exists: (p) => fs.existsSync(p),
    which,
    preference: readSettings(dataDir).browser,
    defaultKind: defaultBrowserKind({ run: runCapture }),
  });
}

function profileDirFor(dataDir) {
  return path.join(dataDir, 'browser-profil');
}

/**
 * Startet das App-Fenster und laesst es los (kein Warten). Gibt die Wahl zurueck, mit der es gestartet wurde,
 * oder null, wenn kein passender Browser vorhanden ist bzw. das Starten sofort scheitert.
 */
function openDetached({ url, dataDir, env = process.env, size = null, log = () => {} }) {
  for (const choice of findBrowsers(dataDir, env)) {
    try {
      fs.mkdirSync(profileDirFor(dataDir), { recursive: true });
      const child = spawn(choice.exe, appWindowArgs(url, profileDirFor(dataDir), { size }), { stdio: 'ignore', detached: true });
      child.on('error', (err) => log(`Browser ${choice.exe} konnte nicht gestartet werden: ${err.message}`));
      child.unref();
      log(`App-Fenster: ${choice.exe} (${choice.kind || 'angegeben'}, ${choice.how})`);
      return choice;
    } catch (err) {
      log(`Browser ${choice.exe} konnte nicht gestartet werden: ${err.message}`);
    }
  }
  return null;
}

module.exports = { readSettings, which, runCapture, findBrowsers, profileDirFor, openDetached };
