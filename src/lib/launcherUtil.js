'use strict';

// Hilfen fuer src/launcher.js (ohne Nebenwirkungen, damit testbar): welchen Browser nehmen wir fuer das
// App-Fenster, mit welchen Argumenten.

const path = require('path');

const KINDS = ['edge', 'chrome', 'brave', 'chromium'];
const KIND_LABEL = { edge: 'Microsoft Edge', chrome: 'Google Chrome', brave: 'Brave', chromium: 'Chromium' };

/** Moegliche Programmdateien (bzw. PATH-Namen unter Linux) eines Chromium-Browsers. */
function candidatesFor(kind, { platform = process.platform, env = process.env, home = '' } = {}) {
  if (platform === 'win32') {
    const dirs = [env['ProgramFiles(x86)'], env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA].filter(Boolean);
    const rel = {
      edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
      brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      chromium: ['Chromium', 'Application', 'chrome.exe'],
    }[kind];
    return dirs.map((d) => path.win32.join(d, ...rel));
  }
  if (platform === 'darwin') {
    const app = { edge: 'Microsoft Edge', chrome: 'Google Chrome', brave: 'Brave Browser', chromium: 'Chromium' }[kind];
    const roots = ['/Applications', home ? path.posix.join(home, 'Applications') : null].filter(Boolean);
    return roots.map((r) => path.posix.join(r, `${app}.app`, 'Contents', 'MacOS', app));
  }
  return {
    edge: ['microsoft-edge', 'microsoft-edge-stable'],
    chrome: ['google-chrome', 'google-chrome-stable'],
    brave: ['brave-browser', 'brave'],
    chromium: ['chromium', 'chromium-browser'],
  }[kind];
}

/** Alle Kandidaten in fester Reihenfolge (Edge, Chrome, Brave, Chromium). */
function browserCandidates(opts = {}) {
  return KINDS.flatMap((k) => candidatesFor(k, opts));
}

/** Welcher unterstuetzte Browser ist der Standardbrowser? (Windows: Registry, Linux: xdg-settings, sonst unbekannt) */
function defaultBrowserKind({ platform = process.platform, run } = {}) {
  let text = '';
  try {
    if (platform === 'win32') text = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']) || '';
    else if (platform === 'linux') text = run('xdg-settings', ['get', 'default-web-browser']) || '';
  } catch { return null; }
  if (/brave/i.test(text)) return 'brave';
  if (/msedge|edge/i.test(text)) return 'edge';
  if (/chromium/i.test(text)) return 'chromium';
  if (/chrome/i.test(text)) return 'chrome';
  return null;
}

/**
 * Waehlt den Browser fuer das App-Fenster: ZEIT_BROWSER > Einstellung (Edge/Chrome/Brave/Chromium oder ein Pfad)
 * > Standardbrowser, falls es ein unterstuetzter ist > Edge, Chrome, Brave, Chromium.
 * exists(pfad) prueft eine Datei, which(name) sucht im PATH (Linux).
 * @returns {{exe: string, kind: string|null, how: string}|null}
 */
function chooseBrowser({ platform = process.platform, env = process.env, home = '', exists, which, preference, defaultKind = null }) {
  if (env.ZEIT_BROWSER) return { exe: env.ZEIT_BROWSER, kind: null, how: 'ZEIT_BROWSER' };
  const pref = String(preference || 'auto').trim();
  if (/[\\/]/.test(pref) && exists(pref)) return { exe: pref, kind: null, how: 'Einstellung (Pfad)' };
  const order = [];
  if (KINDS.includes(pref.toLowerCase())) order.push(pref.toLowerCase());
  if (defaultKind && !order.length) order.push(defaultKind);
  for (const k of KINDS) if (!order.includes(k)) order.push(k);
  for (const kind of order) {
    for (const candidate of candidatesFor(kind, { platform, env, home })) {
      const found = platform === 'linux' ? which(candidate) : (exists(candidate) ? candidate : null);
      if (found) {
        const how = kind === pref.toLowerCase() ? 'Einstellung' : kind === defaultKind && order[0] === kind ? 'Standardbrowser' : 'automatisch';
        return { exe: found, kind, how };
      }
    }
  }
  return null;
}

/** Wie chooseBrowser, aber nur der Pfad (oder null). */
function findBrowser(opts) {
  const chosen = chooseBrowser(opts);
  return chosen ? chosen.exe : null;
}

/** Argumente fuer das App-Fenster: eigenes Profil = eigene Browser-Instanz, getrennt vom Alltags-Browser. */
function appWindowArgs(url, profileDir, { size } = {}) {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    ...(size ? [`--window-size=${size[0]},${size[1]}`] : []),
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

module.exports = { KINDS, KIND_LABEL, browserCandidates, candidatesFor, defaultBrowserKind, chooseBrowser, findBrowser, appWindowArgs, psQuote, appleScriptQuote };
