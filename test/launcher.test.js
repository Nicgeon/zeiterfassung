'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const express = require('express');
const { createIdleMonitor, createRouter } = require('../src/lib/appMode');
const { findBrowser, browserCandidates, appWindowArgs, psQuote, appleScriptQuote, shouldDetach, startMenuScript } = require('../src/lib/launcherUtil');

// --- Leerlauf-Waechter ---------------------------------------------------------------------------------

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    active: () => timers.filter((t) => !t.cleared),
  };
}

test('Leerlauf-Wächter: erst nach dem ersten Ping aktiv, Seitenwechsel hebt die kurze Frist auf', () => {
  const ft = fakeTimers();
  let idle = 0;
  const m = createIdleMonitor({ idleMs: 1000, closingMs: 100, onIdle: () => { idle += 1; }, setTimer: ft.setTimer, clearTimer: ft.clearTimer });
  m.closing(); // vor dem ersten Ping: nichts
  assert.equal(ft.active().length, 0);
  m.ping();
  assert.deepEqual(ft.active().map((t) => t.ms), [1000]);
  m.closing(); // Seite wird verlassen
  assert.deepEqual(ft.active().map((t) => t.ms), [100]);
  m.ping(); // neue Seite meldet sich: kurze Frist weg, lange wieder an
  assert.deepEqual(ft.active().map((t) => t.ms), [1000]);
  ft.active()[0].fn();
  assert.equal(idle, 1);
  m.stop();
  assert.equal(ft.active().length, 0);
});

// --- Routen -----------------------------------------------------------------------------------------------

const windows = [];
async function withRouter(opts, fn) {
  const calls = [];
  const monitor = { ping: () => calls.push('ping'), closing: () => calls.push('closing') };
  const app = express();
  app.use(express.json());
  app.use('/api/app', createRouter({ monitor, quit: () => calls.push('quit'), setTimer: (f) => { f(); return null; }, ...opts }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/app`;
  try { await fn(base, calls); } finally { server.close(); }
}

test('Ping-Route: Zustände, Herkunftsprüfung, nur im Programm-Modus wirksam', async () => {
  await withRouter({ appMode: true }, async (base, calls) => {
    assert.deepEqual(await (await fetch(`${base}/ping?state=open`)).json(), { appMode: true, seen: false, lastLoad: 0 });
    await fetch(`${base}/ping?state=closing`);
    await fetch(`${base}/ping?state=probe`); // wirkt nicht
    assert.deepEqual(calls, ['ping', 'closing']);
    // fremde Webseite (cross-site) darf nichts ausloesen
    const bad = await fetch(`${base}/ping?state=closing`, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(bad.status, 403);
    const ok = await fetch(`${base}/ping?state=open`, { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, ['ping', 'closing', 'ping']);
    await fetch(`${base}/quit`, { method: 'POST' });
    assert.equal(calls.at(-1), 'quit');
  });
  await withRouter({ appMode: true, openWindow: (kind) => { windows.push(kind); return true; } }, async (base) => {
    const post = (body) => fetch(`${base}/window`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.deepEqual(await (await post({ kind: 'mini' })).json(), { opened: true });
    assert.equal((await post({ kind: 'xyz' })).status, 400);
    assert.deepEqual(windows, ['mini']);
  });
  await withRouter({ appMode: false }, async (base) => {
    const r = await fetch(`${base}/window`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'main' }) });
    assert.deepEqual(await r.json(), { opened: false }); // ohne Starter: die Seite oeffnet selbst ein Popup
  });
  await withRouter({ appMode: false }, async (base, calls) => {
    assert.deepEqual(await (await fetch(`${base}/ping?state=open`)).json(), { appMode: false, seen: false, lastLoad: 0 });
    assert.deepEqual(calls, []);
  });
});

// --- Browser-Suche -------------------------------------------------------------------------------------------

test('findBrowser: Edge vor Chrome unter Windows, Mac-Programmordner, Linux über PATH, ZEIT_BROWSER hat Vorrang', () => {
  const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' };
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(findBrowser({ platform: 'win32', env, exists: (p) => p === edge }), edge);
  const chrome = 'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(findBrowser({ platform: 'win32', env, exists: (p) => p === chrome }), chrome);
  assert.equal(findBrowser({ platform: 'win32', env, exists: () => false }), null);

  assert.equal(findBrowser({ platform: 'darwin', env: {}, home: '/Users/x', exists: (p) => p === '/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }),
    '/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.ok(browserCandidates({ platform: 'darwin', home: '' }).includes('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));

  assert.equal(findBrowser({ platform: 'linux', env: {}, which: (n) => (n === 'chromium' ? '/usr/bin/chromium' : null) }), '/usr/bin/chromium');
  assert.equal(findBrowser({ platform: 'linux', env: { ZEIT_BROWSER: '/opt/mein-browser' }, which: () => null }), '/opt/mein-browser');
});

test('Fenster-Argumente und Maskierung für Dialoge', () => {
  assert.deepEqual(appWindowArgs('http://localhost:4711', '/d/profil').slice(0, 2), ['--app=http://localhost:4711', '--user-data-dir=/d/profil']);
  assert.ok(appWindowArgs('http://x', '/p').includes('--no-first-run'));
  assert.equal(psQuote("Node's fehlt"), "'Node''s fehlt'");
  assert.equal(appleScriptQuote('Sag "Hallo"\\'), '"Sag \\"Hallo\\"\\\\"');
});

// --- Starter: ganzer Ablauf mit einem Schein-Browser ------------------------------------------------------------

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}


/** Schein-Browser: schreibt seine Argumente auf, meldet sich einmal beim Server (wie die Seite im Fenster) und lebt bis "close" erscheint. */
function writeFakeBrowser(dir, { argsFile = 'browser-args', append = false, ping = true } = {}) {
  const file = path.join(dir, 'fake-browser.sh');
  // wie die Seite im Fenster: der Zugangsschlüssel kommt mit der Fensteradresse (--app=…?zugang=…), danach als Cookie
  const pingJs = "const a=process.argv.find(x=>x.startsWith('--app='));const z=a?new URL(a.slice(6)).searchParams.get('zugang'):'';" +
    "require('http').get({host:'127.0.0.1',port:process.env.PORT,path:'/api/app/ping?state=open&load=1',headers:{Cookie:'zeit.zugang='+z}},r=>r.resume()).on('error',()=>{})";
  const pingCmd = ping ? `"${process.execPath}" -e "${pingJs}" -- "$@"\n` : '';
  fs.writeFileSync(file, `#!/bin/sh\necho "$@" ${append ? '>>' : '>'} "${dir}/${argsFile}"\n${pingCmd}while [ ! -f "${dir}/close" ]; do sleep 0.2; done\n`, { mode: 0o755 });
  return file;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error('Zeitüberschreitung beim Warten');
}
// Zugangsschlüssel je Testinstanz (Port -> Datenordner), damit die Prüfanfragen wie das Programmfenster ankommen
const dirByPort = new Map();
const accessCookie = (port) => {
  try { return { Cookie: `zeit.zugang=${JSON.parse(fs.readFileSync(path.join(dirByPort.get(port), 'keys.json'), 'utf8')).accessToken}` }; } catch { return {}; }
};
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { ...accessCookie(port), ...headers } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  }).on('error', reject);
});

test('Starter: Server unsichtbar mit App-Fenster; Ende des Fensters beendet alles; Ping-Ende ebenso', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-launcher-'));
  const port = await freePort();
  dirByPort.set(port, dir);
  const fake = writeFakeBrowser(dir);
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), ZEIT_BROWSER: fake, UPDATE_CHECK: 'false', ZEIT_IDLE_MS: '60000', ZEIT_CLOSING_MS: '400' };
  delete env.ENCRYPTION_KEY;
  const launcher = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'launcher.js')], { env, stdio: 'ignore' });
  const exited = new Promise((r) => launcher.on('exit', (code) => r(code)));
  try {
    // Server laeuft, Fenster wurde mit --app und eigenem Profil gestartet
    await until(() => fs.existsSync(path.join(dir, 'browser-args')));
    const args = fs.readFileSync(path.join(dir, 'browser-args'), 'utf8');
    assert.match(args, new RegExp(`--app=http://localhost:${port}`));
    assert.match(args, /--user-data-dir=.*browser-profil/);
    const ping = await get(port, '/api/app/ping?state=probe');
    assert.equal(JSON.parse(ping.body).appMode, true);
    assert.ok(fs.readFileSync(path.join(dir, 'zeiterfassung.log'), 'utf8').includes('Server gestartet'));

    // Zweiter Start: Zeiterfassung laeuft schon -> nur ein weiteres Fenster, kein zweiter Server
    fs.rmSync(path.join(dir, 'browser-args'));
    const second = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'launcher.js')], { env, stdio: 'ignore' });
    const secondCode = await new Promise((r) => second.on('exit', r));
    assert.equal(secondCode, 0);
    await until(() => fs.existsSync(path.join(dir, 'browser-args')));
    assert.equal((await get(port, '/api/app/ping?state=probe')).status, 200);

    // Fenster schliessen (Schein-Browser endet nach >10 s?) - hier: Server-Ping-Ende pruefen
    await get(port, '/api/app/ping?state=open');
    await get(port, '/api/app/ping?state=closing');
    await until(async () => (await get(port, '/api/app/ping?state=probe').catch(() => null)) === null, 8000);
    const code = await Promise.race([exited, sleep(8000).then(() => 'zu langsam')]);
    assert.equal(code, 0);
    assert.match(fs.readFileSync(path.join(dir, 'zeiterfassung.log'), 'utf8'), /Server beendet \(Code 0/);
  } finally {
    fs.writeFileSync(path.join(dir, 'close'), '');
    launcher.kill();
  }
});

test('Starter: Schließt die Person das Fenster (Browser-Prozess endet), beendet sich auch der Server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-launcher2-'));
  const port = await freePort();
  dirByPort.set(port, dir);
  const fake = writeFakeBrowser(dir, { argsFile: 'unused' });
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), ZEIT_BROWSER: fake, UPDATE_CHECK: 'false', ZEIT_MIN_WINDOW_MS: '800' };
  delete env.ENCRYPTION_KEY;
  const launcher = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'launcher.js')], { env, stdio: 'ignore' });
  const exited = new Promise((r) => launcher.on('exit', (code) => r(code)));
  try {
    await until(async () => (await get(port, '/api/app/ping?state=probe').catch(() => null)));
    await sleep(1200); // Fenster lebt laenger als die Mindestzeit
    fs.writeFileSync(path.join(dir, 'close'), ''); // Fenster zu
    const code = await Promise.race([exited, sleep(10000).then(() => 'zu langsam')]);
    assert.equal(code, 0);
    assert.equal(await get(port, '/api/app/ping?state=probe').catch(() => null), null, 'Server ist beendet');
    assert.match(fs.readFileSync(path.join(dir, 'zeiterfassung.log'), 'utf8'), /Fenster geschlossen - beende Zeiterfassung/);
  } finally {
    launcher.kill();
  }
});

test('Starter: Beenden-Route der Seite beendet Server und Starter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-launcher3-'));
  const port = await freePort();
  dirByPort.set(port, dir);
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), UPDATE_CHECK: 'false' };
  delete env.ENCRYPTION_KEY;
  const launcher = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'launcher.js'), '--kein-fenster'], { env, stdio: 'ignore' });
  const exited = new Promise((r) => launcher.on('exit', (code) => r(code)));
  try {
    await until(async () => (await get(port, '/api/app/ping?state=probe').catch(() => null)));
    // POST braucht den CSRF-Token der Sitzung: Cookie + Token holen wie die Seite
    const access = accessCookie(port).Cookie;
    const tokenRes = await fetch(`http://127.0.0.1:${port}/api/csrf-token`, { headers: { cookie: access } });
    const cookies = [access, ...tokenRes.headers.getSetCookie().map((c) => c.split(';')[0])].join('; ');
    const { csrfToken } = await tokenRes.json();
    const quit = await fetch(`http://127.0.0.1:${port}/api/app/quit`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(quit.status, 200);
    assert.equal(await Promise.race([exited, sleep(8000).then(() => 'zu langsam')]), 0);
  } finally {
    launcher.kill();
  }
});

test('Starter mit --mini: öffnet nur das kleine Fenster mit fester Größe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-launcher4-'));
  const port = await freePort();
  dirByPort.set(port, dir);
  const fake = writeFakeBrowser(dir);
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), ZEIT_BROWSER: fake, UPDATE_CHECK: 'false' };
  delete env.ENCRYPTION_KEY;
  const launcher = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'launcher.js'), '--mini'], { env, stdio: 'ignore' });
  try {
    await until(() => fs.existsSync(path.join(dir, 'browser-args')));
    const args = fs.readFileSync(path.join(dir, 'browser-args'), 'utf8');
    assert.match(args, new RegExp(`--app=http://localhost:${port}/index\\.html\\?mini=1`));
    assert.match(args, /--window-size=460,400/);
  } finally {
    fs.writeFileSync(path.join(dir, 'close'), '');
    launcher.kill();
  }
});

test('appWindowArgs: Größe nur auf Wunsch', () => {
  assert.ok(!appWindowArgs('http://x', '/p').some((a) => a.startsWith('--window-size')));
  assert.ok(appWindowArgs('http://x', '/p', { size: [480, 420] }).includes('--window-size=480,420'));
});

test('Fensterwechsel: Die Seite fordert über den Server weitere App-Fenster beim Starter an (Mini und groß)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-launcher5-'));
  const port = await freePort();
  dirByPort.set(port, dir);
  const fake = writeFakeBrowser(dir, { argsFile: 'browser-calls', append: true });
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), ZEIT_BROWSER: fake, UPDATE_CHECK: 'false' };
  delete env.ENCRYPTION_KEY;
  const launcher = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'launcher.js')], { env, stdio: 'ignore' });
  const calls = () => (fs.existsSync(path.join(dir, 'browser-calls')) ? fs.readFileSync(path.join(dir, 'browser-calls'), 'utf8').trim().split('\n') : []);
  try {
    await until(() => calls().length >= 1);
    assert.match(calls()[0], new RegExp(`--app=http://localhost:${port}(?!/index)`)); // erstes Fenster: gross
    // die Fensteradresse trägt den Zugangsschlüssel, der Rest kommt danach als Cookie
    assert.match(calls()[0], /[?&]zugang=[0-9a-f]{64}/);
    const access = accessCookie(port).Cookie;
    const tokenRes = await fetch(`http://127.0.0.1:${port}/api/csrf-token`, { headers: { cookie: access } });
    const cookies = [access, ...tokenRes.headers.getSetCookie().map((c) => c.split(';')[0])].join('; ');
    const { csrfToken } = await tokenRes.json();
    const post = (body) => fetch(`http://127.0.0.1:${port}/api/app/window`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const mini = await post({ kind: 'mini' });
    assert.deepEqual(await mini.json(), { opened: true });
    await until(() => calls().length >= 2);
    assert.match(calls()[1], new RegExp(`--app=http://localhost:${port}/index\\.html\\?mini=1`));
    assert.match(calls()[1], /--window-size=460,400/);

    assert.deepEqual(await (await post({ kind: 'main' })).json(), { opened: true });
    await until(() => calls().length >= 3);
    assert.match(calls()[2], new RegExp(`--app=http://localhost:${port}\\?zugang=[0-9a-f]{64} `)); // grosses Fenster, ohne feste Größe
    assert.doesNotMatch(calls()[2], /--window-size/);

    assert.equal((await post({ kind: 'quatsch' })).status, 400);
    assert.equal(calls().length, 3);
  } finally {
    fs.writeFileSync(path.join(dir, 'close'), '');
    launcher.kill();
  }
});

test('Browserwahl: Einstellung vor Standardbrowser vor Reihenfolge; Standardbrowser aus Registry/xdg erkannt', () => {
  const { chooseBrowser, defaultBrowserKind } = require('../src/lib/launcherUtil');
  const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF' };
  const all = () => true;
  assert.equal(defaultBrowserKind({ platform: 'win32', run: () => '    ProgId    REG_SZ    BraveHTML\r\n' }), 'brave');
  assert.equal(defaultBrowserKind({ platform: 'win32', run: () => 'ProgId REG_SZ MSEdgeHTM' }), 'edge');
  assert.equal(defaultBrowserKind({ platform: 'win32', run: () => 'ProgId REG_SZ ChromeHTML' }), 'chrome');
  assert.equal(defaultBrowserKind({ platform: 'win32', run: () => 'ProgId REG_SZ FirefoxURL-308046B0AF4A39CB' }), null);
  assert.equal(defaultBrowserKind({ platform: 'win32', run: () => { throw new Error('reg fehlt'); } }), null);
  assert.equal(defaultBrowserKind({ platform: 'linux', run: () => 'brave-browser.desktop\n' }), 'brave');
  assert.equal(defaultBrowserKind({ platform: 'darwin', run: () => 'x' }), null);

  // automatisch: Standardbrowser zuerst (hier Brave), sonst Edge
  assert.match(chooseBrowser({ platform: 'win32', env, exists: all, defaultKind: 'brave' }).exe, /brave\.exe$/);
  assert.match(chooseBrowser({ platform: 'win32', env, exists: all }).exe, /msedge\.exe$/);
  // Einstellung schlägt Standardbrowser
  const c = chooseBrowser({ platform: 'win32', env, exists: all, defaultKind: 'brave', preference: 'chrome' });
  assert.deepEqual([c.kind, c.how], ['chrome', 'Einstellung']);
  // nicht installierter Wunsch: nächster vorhandener
  const only = (p) => /chrome\.exe$/.test(p);
  assert.equal(chooseBrowser({ platform: 'win32', env, exists: only, preference: 'brave' }).kind, 'chrome');
  // Pfad aus der Einstellungsdatei (nur von Hand setzbar)
  assert.equal(chooseBrowser({ platform: 'win32', env, exists: (p) => p === 'D:\\Browser\\x.exe', preference: 'D:\\Browser\\x.exe' }).exe, 'D:\\Browser\\x.exe');
  assert.equal(chooseBrowser({ platform: 'win32', env, exists: () => false }), null);
});

test('Einstellungsroute: nur Stichwörter, Datei bleibt erhalten', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-settings-')), 'launcher.json');
  fs.writeFileSync(file, JSON.stringify({ andere: 1 }));
  await withRouter({ appMode: true, settingsFile: file, currentBrowser: { kind: 'edge', exe: 'C:\\x\\msedge.exe', how: 'automatisch' } }, async (base) => {
    const put = (body) => fetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await put({ browser: 'brave' })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { andere: 1, browser: 'brave' });
    assert.equal((await put({ browser: 'C:\\evil.exe' })).status, 400); // nie ein Pfad aus dem Netz
    const get = await (await fetch(`${base}/settings`)).json();
    assert.equal(get.browser, 'brave');
    assert.equal(get.current.kind, 'edge');
    assert.deepEqual(get.options, ['auto', 'edge', 'chrome', 'brave', 'chromium']);
  });
});

test('openDetached (Zeiterfassung-starten --konsole): öffnet App-Fenster mit eigenem Profil, nie den Standardbrowser; ohne Browser null', () => {
  const { openDetached } = require('../src/lib/appWindow');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-detached-'));
  const fake = writeFakeBrowser(dir, { ping: false });
  const logs = [];
  const choice = openDetached({ url: 'http://127.0.0.1:1/', dataDir: dir, env: { ...process.env, ZEIT_BROWSER: fake }, log: (m) => logs.push(m) });
  assert.ok(choice && choice.exe === fake);
  fs.writeFileSync(path.join(dir, 'close'), '');
  return until(() => fs.existsSync(path.join(dir, 'browser-args')), 5000).then(() => {
    const args = fs.readFileSync(path.join(dir, 'browser-args'), 'utf8');
    assert.match(args, /--app=http:\/\/127\.0\.0\.1:1\//);
    assert.match(args, /--user-data-dir=.*browser-profil/);
    assert.ok(logs.some((l) => l.includes('App-Fenster')));
  });
});

test('Autostart: Dateien und Inhalte je Plattform, im Benutzerordner, ohne Fremdtext im Befehl', () => {
  const { autostartFile, autostartContent, createAutostart } = require('../src/lib/autostart');
  assert.match(autostartFile({ platform: 'win32', home: 'C:\\Users\\x', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } }), /Startup[\\/]Zeiterfassung\.vbs$/);
  assert.match(autostartFile({ platform: 'darwin', home: '/Users/x' }), /LaunchAgents\/de\.zeiterfassung\.hintergrund\.plist$/);
  assert.match(autostartFile({ platform: 'linux', home: '/home/x' }), /\.config\/autostart\/zeiterfassung\.desktop$/);
  assert.equal(autostartFile({ platform: 'freebsd' }), null);
  assert.match(autostartContent('win32', 'C:\\Programme\\Zeit'), /start-app\.bat.*--hintergrund/);
  assert.match(autostartContent('darwin', '/Users/x/Zeit & Co'), /Zeit &amp; Co\/start-app\.sh/);
  assert.match(autostartContent('linux', '/home/x/Zeit'), /Exec=\/bin\/bash ".*start-app\.sh" --hintergrund/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-auto-'));
  const a = createAutostart({ root: '/opt/zeit', platform: 'linux', home });
  assert.equal(a.isEnabled(), false);
  a.enable();
  assert.equal(a.isEnabled(), true);
  assert.match(fs.readFileSync(a.file, 'utf8'), /opt\/zeit\/start-app\.sh/);
  a.disable();
  assert.equal(a.isEnabled(), false);
  assert.equal(createAutostart({ root: '/x', platform: 'freebsd' }).supported, false);

  // Windows: genau ein Paar Anführungszeichen um den Pfad (wie Zeiterfassung-Mini.vbs), Datei als UTF-16 mit BOM
  const vbs = autostartContent('win32', 'C:\\Users\\Jörg Müller\\Zeit\\');
  assert.ok(vbs.includes('dir = "C:\\Users\\Jörg Müller\\Zeit"\r\n'));
  assert.ok(vbs.includes('sh.Run "cmd /c """ & dir & "\\start-app.bat"" --hintergrund", 0, False'));
  const written = {};
  const fakeFs = { mkdirSync() {}, writeFileSync: (f, data) => { written.data = data; }, existsSync: () => true, rmSync() {} };
  createAutostart({ root: 'C:\\Zeit', platform: 'win32', env: { APPDATA: 'C:\\AppData' }, fsImpl: fakeFs }).enable();
  assert.deepEqual([...written.data.subarray(0, 2)], [0xff, 0xfe]);
  assert.match(written.data.subarray(2).toString('utf16le'), /start-app\.bat/);
});

test('Einstellungsroute: Hintergrund und Autostart (Autostart schaltet Hintergrund ein), ungültige Werte abgelehnt', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-settings2-')), 'launcher.json');
  let on = false;
  const autostart = { supported: true, isEnabled: () => on, enable: () => { on = true; }, disable: () => { on = false; } };
  await withRouter({ appMode: true, settingsFile: file, autostart }, async (base) => {
    const put = (body) => fetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await put({})).status, 400);
    assert.equal((await put({ background: 'ja' })).status, 400);
    assert.equal((await put({ autostart: 1 })).status, 400);
    let r = await (await put({ background: true })).json();
    assert.equal(r.background, true);
    assert.equal(r.autostart, false);
    r = await (await put({ background: false })).json();
    assert.equal(r.background, false);
    r = await (await put({ autostart: true })).json();
    assert.equal(r.autostart, true);
    assert.equal(r.background, true, 'Autostart braucht das Weiterlaufen im Hintergrund');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).background, true);
    r = await (await fetch(`${base}/settings`)).json();
    assert.equal(r.autostartSupported, true);
  });
  await withRouter({ appMode: true, settingsFile: file }, async (base) => {
    const res = await fetch(`${base}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autostart: true }) });
    assert.equal(res.status, 400);
    assert.equal((await (await fetch(`${base}/settings`)).json()).autostartSupported, false);
  });
});

test('Starter im Hintergrund-Betrieb: Fenster zu, Programm läuft weiter; Beenden-Route beendet es', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-launcher-bg-'));
  fs.writeFileSync(path.join(dir, 'launcher.json'), JSON.stringify({ background: true }));
  const port = await freePort();
  dirByPort.set(port, dir);
  const fake = writeFakeBrowser(dir, { argsFile: 'unused' });
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), ZEIT_BROWSER: fake, UPDATE_CHECK: 'false', ZEIT_MIN_WINDOW_MS: '800', ZEIT_IDLE_MS: '60000', ZEIT_CLOSING_MS: '400', ZEIT_NO_REMINDERS: '1' };
  delete env.ENCRYPTION_KEY;
  const launcher = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'launcher.js')], { env, stdio: 'ignore' });
  let exitedWith = null;
  launcher.on('exit', (code) => { exitedWith = code; });
  try {
    await until(async () => (await get(port, '/api/app/ping?state=probe').catch(() => null)));
    await sleep(1200);
    fs.writeFileSync(path.join(dir, 'close'), ''); // Fenster zu
    await until(() => /läuft im Hintergrund weiter/.test(fs.readFileSync(path.join(dir, 'zeiterfassung.log'), 'utf8')), 10000);
    await get(port, '/api/app/ping?state=closing'); // auch das Ping-Ende beendet im Hintergrund-Betrieb nichts
    await sleep(1500);
    assert.equal(exitedWith, null, 'Starter läuft weiter');
    assert.notEqual(await get(port, '/api/app/ping?state=probe').catch(() => null), null, 'Server läuft weiter');
  } finally {
    launcher.kill();
  }
});

test('Hintergrund-Start (--hintergrund): kein Fenster, Server läuft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-launcher-bg2-'));
  const port = await freePort();
  dirByPort.set(port, dir);
  const fake = writeFakeBrowser(dir, { argsFile: 'browser-args' });
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), ZEIT_BROWSER: fake, UPDATE_CHECK: 'false', ZEIT_NO_REMINDERS: '1' };
  delete env.ENCRYPTION_KEY;
  const launcher = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'launcher.js'), '--hintergrund'], { env, stdio: 'ignore' });
  try {
    await until(async () => (await get(port, '/api/app/ping?state=probe').catch(() => null)));
    await until(() => /Hintergrund-Start: kein Fenster/.test(fs.readFileSync(path.join(dir, 'zeiterfassung.log'), 'utf8')), 10000);
    assert.equal(fs.existsSync(path.join(dir, 'browser-args')), false, 'kein Browser gestartet');
  } finally {
    fs.writeFileSync(path.join(dir, 'close'), '');
    launcher.kill();
  }
});

test('Ticket im Standardbrowser öffnen: nur feste Jira-Adressen, keine Shell, keine beliebige Adresse', async () => {
  const opened = [];
  await withRouter({ appMode: true, openExternal: (u) => { opened.push(u); return true; } }, async (base) => {
    const post = (url) => fetch(`${base}/open-external`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    assert.deepEqual(await (await post('https://firma.atlassian.net/browse/IT-12')).json(), { opened: true });
    for (const bad of ['http://firma.atlassian.net/browse/IT-12', 'https://evil.com/browse/IT-12', 'https://firma.atlassian.net/browse/IT-12?x=1', 'https://firma.atlassian.net/browse/IT-12 & calc',
      'https://firma.atlassian.net/browse/it-12', 'file:///C:/Windows/System32/calc.exe', 'https://x.atlassian.net.evil.com/browse/IT-1']) {
      assert.equal((await post(bad)).status, 400, bad);
    }
    assert.equal((await fetch(`${base}/open-external`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
    assert.deepEqual(opened, ['https://firma.atlassian.net/browse/IT-12']);
  });
  const { openInDefaultBrowser } = require('../src/lib/appWindow');
  const calls = [];
  const spawnImpl = (cmd, args) => { calls.push([cmd, args]); return { on() {}, unref() {} }; };
  openInDefaultBrowser('https://f.atlassian.net/browse/IT-1', { platform: 'win32', spawnImpl });
  openInDefaultBrowser('https://f.atlassian.net/browse/IT-1', { platform: 'darwin', spawnImpl });
  openInDefaultBrowser('https://f.atlassian.net/browse/IT-1', { platform: 'linux', spawnImpl });
  assert.deepEqual(calls.map((c) => c[0]), ['cmd', 'open', 'xdg-open']);
  assert.deepEqual(calls[0][1], ['/c', 'start', '""', 'https://f.atlassian.net/browse/IT-1']);
  assert.equal(openInDefaultBrowser('x', { spawnImpl: () => { throw new Error('weg'); } }), false);
});

test('Starter: unter Windows ohne Konsole neu starten (Konsolenfenster schließt sich), sonst nicht', () => {
  assert.equal(shouldDetach({ platform: 'win32', env: {}, argv: ['node', 'launcher.js'] }), true);
  assert.equal(shouldDetach({ platform: 'win32', env: { ZEIT_LAUNCHER_DETACHED: '1' }, argv: ['node', 'launcher.js'] }), false, 'schon neu gestartet');
  assert.equal(shouldDetach({ platform: 'win32', env: {}, argv: ['node', 'launcher.js', '--konsole'] }), false, 'ausdrücklich mit Konsole');
  assert.equal(shouldDetach({ platform: 'linux', env: {}, argv: ['node', 'launcher.js'] }), false);
  assert.equal(shouldDetach({ platform: 'darwin', env: {}, argv: ['node', 'launcher.js'] }), false);
});

test('Startmenü: Einträge für Zeiterfassung und Mini, Pfade sicher maskiert', () => {
  const script = startMenuScript({ programsDir: 'C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs', root: "C:\\Users\\x\\O'Brien\\zeiterfassung" });
  assert.match(script, /Programs\\Zeiterfassung\.lnk'/);
  assert.match(script, /Programs\\Zeiterfassung Mini\.lnk'/);
  assert.match(script, /O''Brien\\zeiterfassung\\Zeiterfassung\.vbs'/, 'Hochkomma verdoppelt');
  assert.match(script, /public\\favicon\.ico'/);
});

test('Leerlauf-Wächter merkt sich, wann zuletzt eine Seite geladen wurde', () => {
  const { createIdleMonitor } = require('../src/lib/appMode');
  const m = createIdleMonitor({ onIdle: () => {}, setTimer: () => null, clearTimer: () => {} });
  m.ping();
  assert.equal(m.lastLoad, 0);
  const before = Date.now();
  m.ping({ load: true });
  assert.ok(m.lastLoad >= before);
});

test('Node.js-Version: Hinweis bei bekannten Sicherheitslücken bzw. nicht mehr unterstützter Reihe', () => {
  const { nodeAdvice } = require('../src/lib/nodeVersion');
  assert.equal(nodeAdvice('24.21.0').outdated, true);
  assert.equal(nodeAdvice('24.21.0').recommended, '24.22.3');
  assert.equal(nodeAdvice('24.22.3').outdated, false);
  assert.equal(nodeAdvice('24.30.0').outdated, false);
  assert.equal(nodeAdvice('22.23.4').outdated, true);
  assert.equal(nodeAdvice('20.19.0').outdated, true, 'Node 20 wird nicht mehr unterstützt');
  assert.equal(nodeAdvice('27.1.0').outdated, true, 'ungerade Reihe');
  assert.equal(nodeAdvice('28.0.0').outdated, false, 'neue gerade Reihe ohne Eintrag');
  assert.match(nodeAdvice('24.21.0').text, /24\.22\.3/);
});
