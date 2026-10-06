'use strict';

// Alles, was nur im lokalen Betrieb (LOCAL_MODE=true) anders ist. Ausserhalb
// des lokalen Modus tun diese Exporte nichts, server.js muss also nicht
// ueberall nach config.localMode verzweigen.

const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const config = require('./config');
const { db } = require('./db');

const LOCAL_USERNAME = 'lokal';

// Lokal laeuft die App ueber http://localhost - nicht auf https hochstufen.
const cspDirectives = config.localMode ? { upgradeInsecureRequests: null } : {};
const helmetOptions = config.localMode ? { strictTransportSecurity: false } : {};

function osUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return 'Lokal';
  }
}

function ensureLocalUser() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(LOCAL_USERNAME);
  if (existing) return existing.id;
  // Zufaelliger, nicht verwendbarer Hash: Anmeldung per Passwort ist im lokalen Modus ohnehin gesperrt.
  const info = db
    .prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, 'user')")
    .run(LOCAL_USERNAME, osUserName(), '!local-' + crypto.randomBytes(16).toString('hex'));
  return Number(info.lastInsertRowid);
}

/**
 * Der eine lokale Nutzer wird automatisch angemeldet. Die Anmelde-, Passwort-,
 * 2FA- und Passkey-Funktionen sind abgeschaltet, weil es nichts gibt, wogegen
 * sie schuetzen wuerden (nur localhost). Muss nach der Session-Middleware
 * eingehaengt werden. Vor dem CSRF-Schutz duerfen hier nur Routen stehen, die
 * nichts veraendern.
 */
function install(app) {
  if (!config.localMode) return;

  const userId = ensureLocalUser();
  app.use((req, res, next) => {
    if (!req.session.userId) req.session.userId = userId;
    next();
  });

  const unavailable = (req, res) =>
    res.status(403).json({ error: 'Im lokalen Modus nicht verfuegbar.' });
  for (const route of ['/api/auth/login', '/api/account/password', '/api/account/totp', '/api/account/passkeys']) {
    app.use(route, unavailable);
  }
  app.post('/api/auth/logout', (req, res) => res.json({ status: 'ok' }));
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* Browser oeffnen ist nur Komfort */ }
}

/** Startmeldung; true, wenn sie im lokalen Modus ausgegeben wurde. */
function announce() {
  if (!config.localMode) return false;
  const url = `http://localhost:${config.port}`;
  // eslint-disable-next-line no-console
  console.log(
    `\nZeiterfassung laeuft lokal: ${url}\nDaten: ${config.dataDir}\n` +
      'Zum Beenden dieses Fenster schliessen oder Strg+C druecken.\n'
  );
  if (process.env.OPEN_BROWSER === '1') openBrowser(url);
  return true;
}

module.exports = { cspDirectives, helmetOptions, install, announce };
