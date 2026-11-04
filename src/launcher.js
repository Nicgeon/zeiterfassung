'use strict';

// Programm-Starter fuer den lokalen Betrieb: startet die Zeiterfassung unsichtbar im Hintergrund und
// oeffnet sie in einem eigenen App-Fenster (Edge/Chrome ohne Tabs und Adressleiste, eigenes Profil -
// Links aus anderen Programmen landen dadurch nie in diesem Fenster).
//
//   node src/launcher.js              Server (unsichtbar) + App-Fenster; Ende, sobald das Fenster zu ist
//   node src/launcher.js --mini       statt des grossen Fensters nur das Mini-Fenster (Aufgabe + Zeit)
//   node src/launcher.js --kein-fenster   nur den Server beaufsichtigen (z. B. fuer Tests)
//
// Gestartet wird es ueber Zeiterfassung.vbs (Windows), Zeiterfassung.app (macOS) bzw. start-app.sh.
// Ausgaben stehen in <Datenordner>/zeiterfassung.log. Umgebungsvariablen: ZEIT_BROWSER (Programm fuer
// das Fenster), PORT, DATA_DIR.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { findBrowser, appWindowArgs, psQuote, appleScriptQuote } = require('./lib/launcherUtil');
const { defaultLocalDataDir } = require('./lib/localKeys');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
try { require('dotenv').config(); } catch { /* vor der ersten Installation noch nicht vorhanden */ }

const RESTART_EXIT_CODE = 75;
const MIN_WINDOW_MS = Number(process.env.ZEIT_MIN_WINDOW_MS) || 10_000; // kuerzer lebende Browser-Prozesse haben nur uebergeben
const NO_WINDOW = process.argv.includes('--kein-fenster') || process.env.ZEIT_NO_WINDOW === '1';
const PORT = parseInt(process.env.PORT || '4711', 10);
const URL_LOCAL = `http://localhost:${PORT}`;
const MINI = process.argv.includes('--mini');
const WINDOW_URL = MINI ? `${URL_LOCAL}/index.html?mini=1` : URL_LOCAL;
const WINDOW_SIZE = MINI ? [480, 420] : null;
const DATA_DIR = process.env.DATA_DIR || defaultLocalDataDir();
const LOG_FILE = path.join(DATA_DIR, 'zeiterfassung.log');
const PROFILE_DIR = path.join(DATA_DIR, 'browser-profil');

// --- Protokoll -----------------------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try {
  if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.alt`);
} catch { /* noch keine Datei */ }
const logFd = fs.openSync(LOG_FILE, 'a');

function log(message) {
  const line = `[${new Date().toLocaleString('de-DE')}] ${message}\n`;
  try { fs.writeSync(logFd, line); } catch { /* egal */ }
  if (process.stdout.isTTY) process.stdout.write(line);
}

// --- Meldungen an die Person (Starter laeuft ohne Fenster) --------------------------------------

function notify(title, text, { block = false } = {}) {
  log(`${title}: ${text}`);
  try {
    if (process.platform === 'win32') {
      const script = `Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show(${psQuote(text)}, ${psQuote(title)})`;
      const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { stdio: 'ignore', windowsHide: true, detached: !block });
      if (!block) child.unref();
    } else if (process.platform === 'darwin') {
      const child = spawn('osascript', ['-e', `display dialog ${appleScriptQuote(text)} with title ${appleScriptQuote(title)} buttons {"OK"} default button "OK"`], { stdio: 'ignore', detached: !block });
      if (!block) child.unref();
    } else {
      for (const [cmd, args] of [['zenity', ['--info', '--title', title, '--text', text]], ['notify-send', [title, text]]]) {
        if (spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0) { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); break; }
      }
    }
  } catch { /* nur Komfort */ }
}

// --- Hilfen -----------------------------------------------------------------------------------------

/** Antwortet auf dem Port UNSERE Zeiterfassung? (eigene Kennung in /api/app/ping) */
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/app/ping?state=probe', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(typeof JSON.parse(body).appMode === 'boolean'); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function portInUse() {
  return new Promise((resolve) => {
    const socket = require('net').connect({ host: '127.0.0.1', port: PORT });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function waitForServer(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function which(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

// --- Vorbereitung (wie start-local.*) ---------------------------------------------------------------------

function runNpm(args) {
  // Unter Windows in einem sichtbaren Fenster, damit die Person sieht, dass beim ersten Start installiert wird.
  if (process.platform === 'win32') {
    return spawnSync(`start "Zeiterfassung: Einrichtung" /wait cmd /c "npm ${args.join(' ')}"`, { shell: true, cwd: ROOT }).status;
  }
  return spawnSync('npm', args, { cwd: ROOT, stdio: ['ignore', logFd, logFd] }).status;
}

function sqliteWorks() {
  return spawnSync(process.execPath, ['-e', "new (require('better-sqlite3'))(':memory:').close()"], { cwd: ROOT, stdio: 'ignore' }).status === 0;
}

function ensureSetup() {
  const pending = path.join(ROOT, '.update-install-pending');
  if (!fs.existsSync(path.join(ROOT, 'node_modules')) || fs.existsSync(pending)) {
    notify('Zeiterfassung', 'Abhängigkeiten werden installiert (nur beim ersten Start oder nach manchen Updates). Das dauert einen Moment, danach öffnet sich das Fenster.');
    if (runNpm(['install', '--omit=dev']) !== 0) throw new Error('npm install ist fehlgeschlagen (Einzelheiten in zeiterfassung.log).');
    fs.rmSync(pending, { force: true });
  }
  if (!sqliteWorks()) {
    log('Node.js-Version hat sich geändert - better-sqlite3 wird neu gebaut ...');
    runNpm(['rebuild', 'better-sqlite3']);
    if (!sqliteWorks()) throw new Error('better-sqlite3 lässt sich nicht laden. Bitte den Ordner node_modules löschen und erneut starten (macOS: ggf. xcode-select --install).');
  }
}

// --- Server beaufsichtigen -----------------------------------------------------------------------------------

const BROWSER = NO_WINDOW ? null : findBrowser({ env: process.env, home: os.homedir(), exists: (p) => fs.existsSync(p), which });
let server = null;
let stopping = false;
// Programm-Modus (Server beendet sich, wenn das Fenster zu ist) nur, wenn ein App-Fenster moeglich ist
const windowMode = !!BROWSER;

function runServerOnce() {
  return new Promise((resolve) => {
    server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, LOCAL_MODE: 'true', ZEIT_SUPERVISED: '1', ZEIT_APP_MODE: windowMode ? '1' : '0', OPEN_BROWSER: '0' },
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    log(`Server gestartet (PID ${server.pid}).`);
    server.on('exit', (code, signal) => { log(`Server beendet (Code ${code}, Signal ${signal}).`); resolve(code); });
    server.on('error', (err) => { log(`Server konnte nicht gestartet werden: ${err.message}`); resolve(1); });
  });
}

async function superviseServer() {
  for (;;) {
    ensureSetup();
    const code = await runServerOnce();
    if (code === RESTART_EXIT_CODE && !stopping) { log('Neustart nach Update ...'); continue; }
    return code;
  }
}

function stopAll(exitCode = 0) {
  stopping = true;
  if (server && server.exitCode === null) { try { server.kill(); } catch { /* egal */ } }
  setTimeout(() => process.exit(exitCode), 500).unref();
}

// --- Fenster --------------------------------------------------------------------------------------------------------

function openDefaultBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }); c.on('error', () => {}); c.unref(); } catch { /* nur Komfort */ }
}

/**
 * Oeffnet das App-Fenster. watchClose: Schliesst die Person das Fenster, endet das Programm.
 */
function openWindow(url, { watchClose }) {
  const exe = BROWSER;
  if (!exe) {
    log('Kein Chrome/Edge gefunden - öffne den Standardbrowser (Das Programm läuft dann weiter, bis „Beenden“ gewählt wird).');
    openDefaultBrowser(url);
    return null;
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  log(`App-Fenster: ${exe}`);
  const started = Date.now();
  const child = spawn(exe, appWindowArgs(url, PROFILE_DIR, { size: WINDOW_SIZE }), { stdio: 'ignore', detached: false });
  child.on('error', (err) => { log(`Browser konnte nicht gestartet werden: ${err.message}`); openDefaultBrowser(url); });
  child.on('exit', (code) => {
    const lived = Date.now() - started;
    log(`App-Fenster beendet (Code ${code}) nach ${Math.round(lived / 1000)} s.`);
    // Lebte der Prozess nur kurz, hat er an eine schon laufende Instanz uebergeben: dann entscheidet der Ping des Servers.
    if (watchClose && lived > MIN_WINDOW_MS) { log('Fenster geschlossen - beende Zeiterfassung.'); stopAll(0); }
  });
  return child;
}

// --- Ablauf -----------------------------------------------------------------------------------------------------------

async function main() {
  log(`Starter gestartet (Port ${PORT}, Datenordner ${DATA_DIR}).`);
  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));

  // Laeuft die Zeiterfassung schon? Dann nur ein weiteres Fenster oeffnen.
  if (await portInUse()) {
    if (await probe()) {
      log('Zeiterfassung läuft bereits - öffne nur das Fenster.');
      if (!NO_WINDOW) openWindow(WINDOW_URL, { watchClose: false });
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    notify('Zeiterfassung', `Der Port ${PORT} ist von einem anderen Programm belegt. Bitte mit PORT=4712 (Umgebungsvariable) starten.`);
    process.exit(1);
  }

  const supervised = superviseServer().then((code) => {
    stopAll(code || 0);
    return code;
  }).catch((err) => {
    notify('Zeiterfassung', `Start fehlgeschlagen: ${err.message}`);
    stopAll(1);
  });

  if (!NO_WINDOW) {
    if (await waitForServer(120_000)) {
      openWindow(WINDOW_URL, { watchClose: true });
    } else {
      notify('Zeiterfassung', 'Der Server ist nicht rechtzeitig gestartet. Einzelheiten stehen in zeiterfassung.log (im Datenordner).');
    }
  }
  await supervised;
}

main().catch((err) => {
  notify('Zeiterfassung', `Unerwarteter Fehler: ${err.message}`);
  process.exit(1);
});
