'use strict';

// Alles, was nur im lokalen Betrieb (LOCAL_MODE=true) anders ist. Ausserhalb
// des lokalen Modus tun diese Exporte nichts, server.js muss also nicht
// ueberall nach config.localMode verzweigen.

const crypto = require('crypto');
const os = require('os');
const config = require('./config');
const { db } = require('./db');

const LOCAL_USERNAME = 'lokal';
const ACCESS_COOKIE = 'zeit.zugang';
const ACCESS_PARAM = 'zugang';

/** Schlüssel prüfen (zeitkonstant). */
function validAccess(value) {
  const token = config.localAccessToken;
  if (!token || typeof value !== 'string' || value.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

/** Adresse mit Zugangsschlüssel (zum Öffnen des Fensters). */
function urlWithAccess(url, token = config.localAccessToken) {
  return token ? `${url}${url.includes('?') ? '&' : '?'}${ACCESS_PARAM}=${encodeURIComponent(token)}` : url;
}

const NO_ACCESS_PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Zeiterfassung</title>
<link rel="stylesheet" href="/css/grundlagen.css"></head><body><div class="shell"><div class="card">
<h2>Kein Zugang</h2><p>Die Zeiterfassung ist geschützt: Ohne Zugangsschlüssel kommen weder Browser noch andere Programme
auf diesem Rechner an die Daten.</p><p><strong>Im Browser öffnen:</strong> im Startmenü „Zeiterfassung im Browser“ wählen
(Windows) bzw. im Programmfenster unter Konto → Programm „Im Standardbrowser öffnen“. Danach funktioniert diese Adresse
in diesem Browser auch direkt, z. B. als Lesezeichen.</p><p>Sonst einfach die Zeiterfassung über die Verknüpfung bzw. im
Startmenü („Zeiterfassung“) öffnen.</p>
</div></div></body></html>`;

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
 * Der eine lokale Nutzer wird automatisch angemeldet – aber nur mit dem Zugangsschlüssel aus keys.json:
 * Der Starter öffnet das Fenster einmal mit ?zugang=<Schlüssel>, der Server tauscht ihn gegen ein Cookie (nur
 * HTTP, SameSite=Strict) und lädt die Adresse ohne Schlüssel neu. Ohne gültiges Cookie gibt es keine Daten. So
 * kommen andere Programme und – auf Terminalservern – andere Benutzer nicht über localhost an die Daten.
 * Die Anmelde-, Passwort-,
 * 2FA- und Passkey-Funktionen sind abgeschaltet, weil es nichts gibt, wogegen
 * sie schuetzen wuerden (nur localhost). Muss nach der Session-Middleware
 * eingehaengt werden. Vor dem CSRF-Schutz duerfen hier nur Routen stehen, die
 * nichts veraendern.
 */
function install(app) {
  if (!config.localMode) return;

  const userId = ensureLocalUser();
  app.use((req, res, next) => {
    // Schlüssel aus der Adresse (vom Starter) gegen das Cookie tauschen, Adresse ohne Schlüssel neu laden
    if (req.method === 'GET' && req.query[ACCESS_PARAM] !== undefined) {
      if (!validAccess(String(req.query[ACCESS_PARAM]))) return res.status(401).type('html').send(NO_ACCESS_PAGE);
      res.cookie(ACCESS_COOKIE, config.localAccessToken, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 400 * 24 * 3600 * 1000 });
      const clean = new URL(req.originalUrl, 'http://localhost');
      clean.searchParams.delete(ACCESS_PARAM);
      return res.redirect(302, clean.pathname + clean.search);
    }
    if (validAccess(req.cookies && req.cookies[ACCESS_COOKIE])) {
      if (!req.session.userId) req.session.userId = userId;
      return next();
    }
    // Übergang: Eine Sitzung, die schon angemeldet ist (Fenster von vor dem Update mit dem Schlüssel), bekommt das
    // Cookie nachgereicht. Neue Sitzungen werden nur noch über den Schlüssel angemeldet, darum bleibt das dicht.
    if (req.session && req.session.userId === userId) {
      res.cookie(ACCESS_COOKIE, config.localAccessToken, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 400 * 24 * 3600 * 1000 });
      return next();
    }
    if (req.path === '/api/health') return next(); // Lebenszeichen ohne Daten
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Kein Zugang: Bitte die Zeiterfassung über die Verknüpfung bzw. das Startmenü öffnen.' });
    }
    return res.status(401).type('html').send(NO_ACCESS_PAGE);
  });

  const unavailable = (req, res) =>
    res.status(403).json({ error: 'Im lokalen Modus nicht verfuegbar.' });
  for (const route of ['/api/auth/login', '/api/account/password', '/api/account/totp', '/api/account/passkeys']) {
    app.use(route, unavailable);
  }
  app.post('/api/auth/logout', (req, res) => res.json({ status: 'ok' }));
}

function openBrowser(url) {
  // Erst ein App-Fenster (eigenes Profil, keine Tabs - landet nie als Tab im normalen Browserfenster)
  const choice = require('./lib/appWindow').openDetached({
    url,
    dataDir: config.dataDir,
    // eslint-disable-next-line no-console
    log: (m) => console.log(m),
  });
  if (choice) return;
  require('./lib/appWindow').openInDefaultBrowser(url);
}

/** Startmeldung; true, wenn sie im lokalen Modus ausgegeben wurde. */
function announce() {
  if (!config.localMode) return false;
  const url = `http://localhost:${config.port}`;
  // eslint-disable-next-line no-console
  console.log(
    // Mit sichtbarer Konsole (--konsole) die Adresse samt Zugangsschlüssel zeigen; beim Starter landet die Ausgabe im
    // Protokoll, dort soll der Schlüssel nicht stehen
    `\nZeiterfassung laeuft lokal: ${process.env.OPEN_BROWSER === '1' ? urlWithAccess(url) : url}\nDaten: ${config.dataDir}\n` +
      (process.env.ZEIT_APP_MODE === '1'
        ? 'Programm-Modus: Das Programm beendet sich, wenn das Fenster geschlossen wird.\n'
        : 'Zum Beenden dieses Fenster schliessen oder Strg+C druecken.\n')
  );
  if (process.env.OPEN_BROWSER === '1') openBrowser(urlWithAccess(url));
  return true;
}

module.exports = { cspDirectives, helmetOptions, install, announce, urlWithAccess, ACCESS_COOKIE };
