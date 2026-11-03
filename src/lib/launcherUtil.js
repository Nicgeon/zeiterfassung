'use strict';

// Hilfen fuer src/launcher.js (ohne Nebenwirkungen, damit testbar): welchen Browser nehmen wir fuer das
// App-Fenster, mit welchen Argumenten.

const path = require('path');

/** Chromium-basierte Browser koennen als "App" ohne Tabs und Adressleiste laufen (--app=URL). */
function browserCandidates({ platform = process.platform, env = process.env, home = '' } = {}) {
  if (platform === 'win32') {
    const dirs = [env['ProgramFiles(x86)'], env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA].filter(Boolean);
    const rel = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
    ];
    return rel.flatMap((parts) => dirs.map((d) => path.win32.join(d, ...parts)));
  }
  if (platform === 'darwin') {
    const apps = [
      ['Google Chrome', 'Google Chrome'],
      ['Microsoft Edge', 'Microsoft Edge'],
      ['Brave Browser', 'Brave Browser'],
      ['Chromium', 'Chromium'],
    ];
    const roots = ['/Applications', home ? path.posix.join(home, 'Applications') : null].filter(Boolean);
    return apps.flatMap(([app, bin]) => roots.map((r) => path.posix.join(r, `${app}.app`, 'Contents', 'MacOS', bin)));
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
}

/**
 * Erster vorhandener Browser. exists(pfad) prueft eine Datei, which(name) sucht im PATH (Linux).
 * Mit ZEIT_BROWSER laesst sich ein Programm fest vorgeben.
 */
function findBrowser({ platform = process.platform, env = process.env, home = '', exists, which }) {
  if (env.ZEIT_BROWSER) return env.ZEIT_BROWSER;
  for (const candidate of browserCandidates({ platform, env, home })) {
    if (platform === 'linux') {
      const found = which(candidate);
      if (found) return found;
    } else if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Argumente fuer das App-Fenster: eigenes Profil = eigene Browser-Instanz, getrennt vom Alltags-Browser. */
function appWindowArgs(url, profileDir) {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
  ];
}

/** Text fuer ein PowerShell-Dialogfenster maskieren (einfache Anfuehrungszeichen). */
function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/** Text fuer AppleScript maskieren. */
function appleScriptQuote(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

module.exports = { browserCandidates, findBrowser, appWindowArgs, psQuote, appleScriptQuote };
