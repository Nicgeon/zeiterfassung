'use strict';

// Programm-Starter fuer den lokalen Betrieb: startet die Zeiterfassung unsichtbar im Hintergrund und
// oeffnet sie in einem eigenen App-Fenster (Edge/Chrome ohne Tabs und Adressleiste, eigenes Profil -
// Links aus anderen Programmen landen dadurch nie in diesem Fenster).
//
//   node src/launcher.js              Server (unsichtbar) + App-Fenster; Ende, sobald das Fenster zu ist
//   node src/launcher.js --mini       statt des grossen Fensters nur das Mini-Fenster (Aufgabe + Zeit)
//   node src/launcher.js --hintergrund   ohne Fenster starten und im Hintergrund laufen (Autostart; Erinnerungen)
//   node src/launcher.js --kein-fenster   nur den Server beaufsichtigen (z. B. fuer Tests)
//
// Gestartet wird es ueber Zeiterfassung.vbs (Windows), Zeiterfassung.app (macOS) bzw. start-app.sh. Unter Windows
// startet es sich sofort ohne Konsole neu, das Konsolenfenster schliesst sich dadurch (--konsole: bleibt sichtbar).
// Ausgaben stehen in <Datenordner>/zeiterfassung.log. Umgebungsvariablen: ZEIT_BROWSER (Programm fuer
// das Fenster), PORT, DATA_DIR.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { appWindowArgs, psQuote, appleScriptQuote, shouldDetach, startMenuScript } = require('./lib/launcherUtil');
const systemToast = require('./lib/notify');
const { findBrowsers, profileDirFor } = require('./lib/appWindow');
const { defaultLocalDataDir, readAccessToken } = require('./lib/localKeys');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

// Windows: sofort ohne Konsole neu starten und hier beenden, damit das Konsolenfenster zugeht (siehe shouldDetach).
// "detached" heißt unter Windows DETACHED_PROCESS: der neue Prozess hat gar keine Konsole, auch keine versteckte.
// Alle weiteren Programme startet er mit windowsHide, sonst bekämen Konsolenprogramme (node, cmd) ein eigenes Fenster.
if (shouldDetach()) {
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ZEIT_LAUNCHER_DETACHED: '1' },
  });
  child.unref();
  process.exit(0);
}
try { require('dotenv').config(); } catch { /* vor der ersten Installation noch nicht vorhanden */ }

const RESTART_EXIT_CODE = 75;
const MIN_WINDOW_MS = Number(process.env.ZEIT_MIN_WINDOW_MS) || 10_000; // kuerzer lebende Browser-Prozesse haben nur uebergeben
const NO_WINDOW = process.argv.includes('--kein-fenster') || process.env.ZEIT_NO_WINDOW === '1';
const PORT = parseInt(process.env.PORT || '4711', 10);
const URL_LOCAL = `http://localhost:${PORT}`;
const MINI = process.argv.includes('--mini');
// Autostart beim Anmelden: kein Fenster oeffnen, nur im Hintergrund laufen (Erinnerungen an Aufgaben)
const BACKGROUND_START = process.argv.includes('--hintergrund');
const MINI_URL = `${URL_LOCAL}/index.html?mini=1`;
const MINI_SIZE = [460, 400];
const windowFor = (kind) => (kind === 'mini' ? { url: MINI_URL, size: MINI_SIZE } : { url: URL_LOCAL, size: null });
const START_KIND = MINI ? 'mini' : 'main';
const DATA_DIR = process.env.DATA_DIR || defaultLocalDataDir();
const LOG_FILE = path.join(DATA_DIR, 'zeiterfassung.log');
const PROFILE_DIR = profileDirFor(DATA_DIR);
/** Soll das Programm nach dem Schliessen des Fensters weiterlaufen? (Konto -> Programm; wird beim Schliessen frisch gelesen) */
function keepRunning() {
  if (BACKGROUND_START) return true;
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'launcher.json'), 'utf8')).background === true; } catch { return false; }
}

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

/** Kurze Systembenachrichtigung (verschwindet von selbst) – für Hinweise, die man nicht wegklicken muss. */
function toast(title, body) {
  log(`${title}: ${body}`);
  systemToast.notify({ title, body }, { log });
}

/** Windows: Startmenü-Einträge anlegen bzw. nach einem Umzug des Programmordners erneuern (für die Windows-Suche). */
function ensureStartMenu() {
  if (process.platform !== 'win32' || !process.env.APPDATA) return;
  const programsDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const marker = path.join(DATA_DIR, 'startmenu.json');
  try {
    if (fs.existsSync(path.join(programsDir, 'Zeiterfassung.lnk')) && JSON.parse(fs.readFileSync(marker, 'utf8')).root === ROOT) return;
  } catch { /* neu anlegen */ }
  try {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', startMenuScript({ programsDir, root: ROOT })], { stdio: 'ignore', windowsHide: true });
    child.on('error', (err) => log(`Startmenü-Einträge nicht möglich: ${err.message}`));
    child.on('exit', (code) => {
      if (code !== 0) { log(`Startmenü-Einträge konnten nicht angelegt werden (Code ${code}).`); return; }
      try { fs.writeFileSync(marker, JSON.stringify({ root: ROOT })); } catch { /* egal */ }
      log('Startmenü-Einträge „Zeiterfassung“ und „Zeiterfassung Mini“ angelegt.');
    });
  } catch (err) {
    log(`Startmenü-Einträge nicht möglich: ${err.message}`);
  }
}

// --- Hilfen -----------------------------------------------------------------------------------------

/** Antwort von UNSERER Zeiterfassung auf dem Port (eigene Kennung in /api/app/ping) oder null. seen: hat sich schon ein Fenster gemeldet? */
// Zugangsschlüssel (keys.json im Datenordner): ohne ihn meldet der Server niemanden an. Er steht erst nach dem ersten
// Serverstart fest, deshalb wird er bei Bedarf gelesen. Nie ins Protokoll schreiben.
const accessToken = () => readAccessToken(DATA_DIR);
/** Fensteradresse mit Schlüssel; der Server tauscht ihn gegen ein Cookie und lädt die Adresse ohne ihn neu. */
function withAccess(url) {
  const token = accessToken();
  return token ? `${url}${url.includes('?') ? '&' : '?'}zugang=${encodeURIComponent(token)}` : url;
}

function probeInfo() {
  return new Promise((resolve) => {
    const token = accessToken();
    const headers = token ? { Cookie: `zeit.zugang=${token}` } : {};
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/app/ping?state=probe', timeout: 1500, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve(typeof j.appMode === 'boolean' ? j : null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
const probe = async () => !!(await probeInfo());

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

// --- Vorbereitung (wie Zeiterfassung-starten.*) ---------------------------------------------------------------------

function runNpm(args) {
  // Unter Windows in einem sichtbaren Fenster, damit die Person sieht, dass beim ersten Start installiert wird.
  if (process.platform === 'win32') {
    // äußere cmd unsichtbar; "start" öffnet das sichtbare Fenster mit npm, es schließt sich danach von selbst
    return spawnSync(`start "Zeiterfassung: Einrichtung" /wait cmd /c "npm ${args.join(' ')}"`, { shell: true, cwd: ROOT, windowsHide: true }).status;
  }
  return spawnSync('npm', args, { cwd: ROOT, stdio: ['ignore', logFd, logFd], windowsHide: true }).status;
}

function sqliteWorks() {
  return spawnSync(process.execPath, ['-e', "new (require('better-sqlite3'))(':memory:').close()"], { cwd: ROOT, stdio: 'ignore', windowsHide: true }).status === 0;
}

function ensureSetup() {
  const pending = path.join(ROOT, '.update-install-pending');
  // Pakete passen nicht zur Paketliste (z. B. Nachinstallieren nach einem Update abgebrochen): ebenfalls installieren
  const mismatches = fs.existsSync(path.join(ROOT, 'node_modules')) ? require('./lib/depsCheck').dependencyMismatches(ROOT) : [];
  if (mismatches.length) log(`Pakete passen nicht zur Paketliste: ${mismatches.map((m) => `${m.name} ${m.installed || 'fehlt'} statt ${m.expected}`).join(', ')}`);
  if (!fs.existsSync(path.join(ROOT, 'node_modules')) || fs.existsSync(pending) || mismatches.length) {
    notify('Zeiterfassung', 'Abhängigkeiten werden installiert (nur beim ersten Start oder nach manchen Updates). Das dauert einen Moment, danach öffnet sich das Fenster.');
    if (runNpm(['install', '--omit=dev']) !== 0) throw new Error('npm install ist fehlgeschlagen. Bitte „Zeiterfassung-starten.bat --konsole“ ausführen, dort steht der Grund (z. B. keine Verbindung zu registry.npmjs.org).');
    const still = require('./lib/depsCheck').dependencyMismatches(ROOT);
    if (still.length) throw new Error(`Pakete fehlen nach der Installation noch: ${still.map((m) => m.name).join(', ')}. Bitte den Ordner node_modules löschen und erneut starten.`);
    fs.rmSync(pending, { force: true });
  }
  if (!sqliteWorks()) {
    log('Node.js-Version hat sich geändert - better-sqlite3 wird neu gebaut ...');
    runNpm(['rebuild', 'better-sqlite3']);
    if (!sqliteWorks()) throw new Error('better-sqlite3 lässt sich nicht laden. Bitte den Ordner node_modules löschen und erneut starten (macOS: ggf. xcode-select --install).');
  }
}

// --- Server beaufsichtigen -----------------------------------------------------------------------------------

// Browser fuer das App-Fenster in der Reihenfolge, in der sie versucht werden (Einstellung "browser" aus
// <Datenordner>/launcher.json, dann Standardbrowser, dann Edge/Chrome/Brave/Chromium)
const CHOICES = NO_WINDOW ? [] : findBrowsers(DATA_DIR, process.env);
const CHOICE = CHOICES[0] || null;
const BROWSER = CHOICE ? CHOICE.exe : null;
let server = null;
let stopping = false;
// Programm-Modus (Server beendet sich, wenn das Fenster zu ist) nur, wenn ein App-Fenster moeglich ist
const windowMode = !!BROWSER;

function runServerOnce() {
  return new Promise((resolve) => {
    server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        LOCAL_MODE: 'true',
        ZEIT_SUPERVISED: '1',
        ZEIT_APP_MODE: windowMode ? '1' : '0',
        OPEN_BROWSER: '0',
        ZEIT_WINDOW_BROWSER: CHOICE ? JSON.stringify({ kind: CHOICE.kind, exe: CHOICE.exe, how: CHOICE.how }) : '', // fuer die Anzeige unter Konto
      },
      stdio: ['ignore', logFd, logFd, 'ipc'], // IPC: der Server kann weitere Fenster anfordern (Mini <-> gross)
      windowsHide: true,
    });
    log(`Server gestartet (PID ${server.pid}).`);
    server.on('message', (msg) => {
      if (msg && msg.type === 'open-window' && ['main', 'mini'].includes(msg.kind) && !NO_WINDOW) {
        log(`Fenster angefordert: ${msg.kind}`);
        const w = windowFor(msg.kind);
        openExtraWindow(w);
      }
    });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Startet einen Browser mit App-Fenster; das Ergebnis (state) sammelt Fehler und Ende des Prozesses. */
function launchApp(choice, { url, size }) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  log(`App-Fenster: ${choice.exe} (${choice.kind || 'angegeben'}, ${choice.how})`);
  const state = { started: Date.now(), exited: false, code: null, error: null, onExit: null };
  const child = spawn(choice.exe, appWindowArgs(withAccess(url), PROFILE_DIR, { size }), { stdio: 'ignore', detached: false });
  child.on('error', (err) => { state.error = err; log(`Browser konnte nicht gestartet werden: ${err.message}`); });
  child.on('exit', (code) => {
    state.exited = true;
    state.code = code;
    const lived = Date.now() - state.started;
    log(`App-Fenster beendet (Code ${code}) nach ${Math.round(lived / 1000)} s.`);
    if (state.onExit) state.onExit(lived);
  });
  return state;
}

/** Schliesst die Person das Fenster (der Browser-Prozess endet nach laengerer Zeit), endet das Programm. */
function watchClose(state) {
  if (state.exited) return;
  // Lebte der Prozess nur kurz, hat er an eine schon laufende Instanz uebergeben: dann entscheidet der Ping des Servers.
  state.onExit = (lived) => {
    if (lived <= MIN_WINDOW_MS) return;
    if (keepRunning()) { log('Fenster geschlossen - Zeiterfassung läuft im Hintergrund weiter.'); return; }
    log('Fenster geschlossen - beende Zeiterfassung.');
    stopAll(0);
  };
}

// Rückmeldung beim Start: hat sich seit dem Öffnen eines Fensters eine Seite geladen (Ping mit load=1)?
let windowShown = false;
const loadedSince = (info, since) => !!info && (info.lastLoad || 0) >= since;
const NOT_VISIBLE_HINT = 'Falls nichts zu sehen ist: im Startmenü erneut „Zeiterfassung“ öffnen oder im Browser http://localhost:' + PORT + ' aufrufen. Einzelheiten stehen in zeiterfassung.log im Datenordner.';

/** Wartet, bis sich nach "since" eine Seite geladen hat; true bei Erfolg. */
async function waitForLoad(since, ms, state) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (loadedSince(await probeInfo(), since)) return true;
    if (state && (state.error || (state.exited && state.code !== 0))) return false;
    await sleep(400);
  }
  return false;
}

/** Fenster laut Browser offen, aber die Seite meldet sich nicht: Hinweis und im Hintergrund weiter warten. */
function warnNoWindow(since) {
  toast('Zeiterfassung: kein Fenster?', `Das Programm läuft, aber das Fenster meldet sich nicht. ${NOT_VISIBLE_HINT}`);
  waitForLoad(since, 120_000).then((ok) => { if (ok) { windowShown = true; log('Fenster hat sich doch noch gemeldet.'); } });
}

/**
 * Erstes Fenster: probiert die Browser der Reihe nach und prueft, ob sich die Seite wirklich meldet (Ping).
 * Der Standardbrowser (als Tab) kommt erst, wenn keiner funktioniert hat - dann mit Hinweis.
 */
async function openFirstWindow(w) {
  if (!CHOICES.length) {
    notify('Zeiterfassung', 'Es wurde weder Edge noch Chrome noch Brave gefunden. Die Zeiterfassung wird im Standardbrowser geöffnet (als Tab). Mit ZEIT_BROWSER oder unter Konto → Programm lässt sich ein Browser festlegen.');
    openDefaultBrowser(withAccess(w.url));
    return;
  }
  for (const choice of CHOICES) {
    const since = Date.now();
    const state = launchApp(choice, w);
    const end = Date.now() + 30_000;
    let result = 'timeout';
    while (Date.now() < end) {
      if (loadedSince(await probeInfo(), since)) { result = 'ok'; break; }
      if (state.error || (state.exited && state.code !== 0)) { result = 'failed'; break; }
      await sleep(400);
    }
    if (result === 'ok') {
      windowShown = true;
      log(`Fenster geöffnet nach ${Math.round((Date.now() - since) / 100) / 10} s.`);
      watchClose(state);
      return;
    }
    if (result === 'timeout' && !state.exited) {
      log('Noch keine Meldung vom Fenster, der Browser läuft aber - warte weiter.');
      warnNoWindow(since);
      watchClose(state);
      return;
    }
    log(`Mit ${choice.exe} ist kein Fenster erschienen (${result}${state.code !== null ? `, Code ${state.code}` : ''}) - versuche den nächsten Browser.`);
  }
  notify('Zeiterfassung', 'Das Programmfenster ließ sich mit keinem Browser öffnen (Einzelheiten in zeiterfassung.log im Datenordner). Die Zeiterfassung wird deshalb im Standardbrowser geöffnet.');
  openDefaultBrowser(withAccess(w.url));
}

/**
 * Weiteres Fenster (zweiter Start, Anforderung der Seite): erster Browser, bei Startfehler der naechste.
 * check: prüfen, ob sich die Seite meldet (beim zweiten Start), sonst Hinweis und Standardbrowser.
 */
async function openExtraWindow(w, { check = false } = {}) {
  if (!CHOICES.length) { openDefaultBrowser(withAccess(w.url)); return; }
  for (const choice of CHOICES) {
    const since = Date.now();
    const state = launchApp(choice, w);
    if (!check) {
      await sleep(1500);
      if (!state.error) return;
      continue;
    }
    if (await waitForLoad(since, 20_000, state)) { log('Weiteres Fenster geöffnet.'); return; }
    if (!state.error && !(state.exited && state.code !== 0)) {
      // Browser läuft, Seite meldet sich nicht: nicht noch ein Fenster mit dem nächsten Browser, sondern Hinweis
      toast('Zeiterfassung: kein Fenster?', `Die Zeiterfassung läuft bereits, das Fenster meldet sich aber nicht. Sie wird jetzt im Standardbrowser geöffnet. ${NOT_VISIBLE_HINT}`);
      openDefaultBrowser(withAccess(w.url));
      return;
    }
    log(`Mit ${choice.exe} ist kein weiteres Fenster erschienen - versuche den nächsten Browser.`);
  }
  openDefaultBrowser(withAccess(w.url));
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
      ensureStartMenu();
      if (!NO_WINDOW && !BACKGROUND_START) await openExtraWindow(windowFor(START_KIND), { check: true });
      process.exit(0);
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

  ensureStartMenu();
  // Dauert der Start länger (Einrichtung, langsamer Rechner), gibt es nach ein paar Sekunden ein Lebenszeichen
  const startHint = !NO_WINDOW && !BACKGROUND_START
    ? setTimeout(() => { if (!windowShown) toast('Zeiterfassung startet …', 'Einen Moment, das Fenster öffnet sich gleich.'); }, 6000)
    : null;
  if (startHint && startHint.unref) startHint.unref();

  if (!NO_WINDOW) {
    if (await waitForServer(120_000)) {
      if (BACKGROUND_START) log('Hintergrund-Start: kein Fenster geöffnet, Erinnerungen sind aktiv.');
      else await openFirstWindow(windowFor(START_KIND));
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
