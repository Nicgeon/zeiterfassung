'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { doubleCsrf } = require('csrf-csrf');

const config = require('./config');
const { db, runRetentionCleanup, SqliteSessionStore } = require('./db');
const requireAuth = require('./middleware/requireAuth');
const requireAdmin = require('./middleware/requireAdmin');
const localMode = require('./localMode');

const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const entriesRoutes = require('./routes/entries');
const timerRoutes = require('./routes/timer');
const adminRoutes = require('./routes/admin');
const updateRoutes = require('./routes/update');
const updater = require('./lib/updater');

const app = express();

if (config.trustProxy) {
  app.set('trust proxy', 1); // nginx proxy manager sits in front of us
}

app.disable('x-powered-by');

// Diagnose-Hinweis: COOKIE_SECURE=true, aber die Anfrage kommt nicht als
// HTTPS an -> der Browser speichert das Session-Cookie dann gar nicht,
// und Login/CSRF schlagen dauerhaft und fuer JEDEN fehl (typisches Symptom:
// "Sicherheitstoken ungueltig oder abgelaufen" bei jedem Login-Versuch).
// Haeufigste Ursache: TLS wird zwar von nginx proxy manager terminiert,
// aber TRUST_PROXY ist nicht gesetzt, oder der Proxy sendet keinen
// "X-Forwarded-Proto: https" Header.
//
// Der Docker-HEALTHCHECK ruft /api/health bewusst direkt per
// http://127.0.0.1 im Container auf, also am Reverse-Proxy vorbei - das
// ist normal und kein Fehlerzeichen, daher werden Loopback-Anfragen hier
// ausgenommen (sonst waere die Warnung ein Fehlalarm bei jedem Neustart).
function isLoopbackRequest(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Nur die konfigurierten Adressen bedienen (RP_ORIGIN + RP_ORIGINS).
// Ohne diese Pruefung antwortet die Anwendung unter jedem Namen, der auf
// den Server zeigt - inhaltlich harmlos, weil Cookies ohnehin pro Domain
// gelten, aber eine fremde Domain koennte so eine echt aussehende
// Anmeldemaske zeigen. Loopback bleibt erlaubt: darueber laeuft der
// Docker-HEALTHCHECK.
if (config.strictHost) {
  const allowedHosts = new Set([...config.originByHost.keys(), 'localhost', '127.0.0.1', '::1']);
  app.use((req, res, next) => {
    if (allowedHosts.has(req.hostname)) return next();
    res.status(421).type('text/plain; charset=utf-8')
      .send('Diese Adresse ist fuer diese Anwendung nicht konfiguriert.');
  });
}

let warnedInsecureCookieMismatch = false;
app.use((req, res, next) => {
  if (config.cookieSecure && !req.secure && !warnedInsecureCookieMismatch && !isLoopbackRequest(req)) {
    warnedInsecureCookieMismatch = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[WARNUNG] COOKIE_SECURE=true, aber eingehende Anfragen kommen nicht als HTTPS an ' +
        '(req.secure=false, Pfad: ' + req.path + ', IP: ' + req.ip + '). Der Browser wird das ' +
        'Session-Cookie dann NICHT speichern - Logins und CSRF-Tokens schlagen dann fuer alle ' +
        'dauerhaft fehl. Pruefen: TRUST_PROXY=true gesetzt? Sendet der Reverse-Proxy ' +
        '"X-Forwarded-Proto: https"? Wird die Seite wirklich ueber https:// aufgerufen ' +
        '(nicht direkt per http:// oder IP)?'
    );
  }
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        ...localMode.cspDirectives,
      },
    },
    ...localMode.helmetOptions,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// --- Statische Assets VOR der Session-Middleware ausliefern -------------
// WICHTIG (Sicherheit): Antworten auf CSS/JS/Fonts duerfen NIEMALS ein
// Session-Cookie enthalten. Reverse-Proxys wie nginx proxy manager ("Cache
// Assets") cachen genau diese Dateitypen und ignorieren dabei Set-Cookie -
// ein Session-Cookie in so einer Antwort wuerde an ALLE Besucher verteilt
// und alle waeren als dieselbe Person angemeldet.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// CSS/JS aendern sich mit jedem Update: "no-cache" heisst, der Browser darf sie speichern,
// fragt aber bei jedem Aufruf per ETag nach (meist nur eine kurze 304-Antwort). Mit einer
// festen Gueltigkeitsdauer liefe nach einem Update bis zu eine Stunde lang alter Code im
// Browser weiter. Schriften aendern sich praktisch nie und duerfen laenger gecacht werden.
const CACHE_CONTROL = {
  css: 'public, no-cache',
  js: 'public, no-cache',
  vendor: 'public, no-cache',
  fonts: 'public, max-age=86400',
};
for (const dir of Object.keys(CACHE_CONTROL)) {
  app.use(
    `/${dir}`,
    express.static(path.join(PUBLIC_DIR, dir), {
      setHeaders: (res) => res.setHeader('Cache-Control', CACHE_CONTROL[dir]),
    })
  );
}

// Alles ab hier (API + HTML-Seiten) ist personenbezogen und darf von
// keinem Proxy/Browser zwischengespeichert werden.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});

app.use(
  session({
    store: new SqliteSessionStore(),
    name: 'zeit.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      maxAge: config.sessionMaxAgeMs,
    },
  })
);

// Lokaler Betrieb: automatische Anmeldung, siehe localMode.js (sonst ohne Wirkung).
localMode.install(app);

// Lazily provision a per-session CSRF secret (also ensures every visitor
// gets a session cookie immediately, which WebAuthn login needs anyway).
app.use((req, res, next) => {
  if (!req.session.csrfSecret) {
    req.session.csrfSecret = crypto.randomBytes(32).toString('hex');
  }
  next();
});

const { doubleCsrfProtection, generateToken } = doubleCsrf({
  getSecret: (req) => req.session.csrfSecret,
  getSessionIdentifier: (req) => req.session.id,
  cookieName: config.cookieSecure ? '__Host-zeit.csrf' : 'zeit.csrf',
  cookieOptions: {
    sameSite: 'lax',
    secure: config.cookieSecure,
    httpOnly: true,
    path: '/',
    maxAge: config.sessionMaxAgeMs,
  },
  size: 64,
  getTokenFromRequest: (req) => req.headers['x-csrf-token'],
});

app.get('/api/csrf-token', (req, res) => {
  // overwrite=true: dieser Endpunkt soll IMMER einen frisch zur aktuellen
  // Sitzung passenden Token liefern. Mit dem Default (overwrite=false)
  // versucht csrf-csrf zunaechst, einen evtl. vorhandenen alten
  // CSRF-Cookie wiederzuverwenden und wirft eine Exception, wenn der
  // nicht mehr zur aktuellen Sitzung passt (z.B. Cookie-Rest von einem
  // frueheren Login/Container-Neustart) - das wuerde ausgerechnet den
  // Endpunkt lahmlegen, dessen einziger Zweck ist, einen gueltigen Token
  // auszustellen, und den Nutzer in einer Sackgasse ohne Weg zurueck
  // festhalten ("Sicherheitstoken ungueltig" bei jedem Versuch, auch nach
  // dem automatischen Retry).
  res.json({ csrfToken: generateToken(req, res, true) });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Every state-changing request from here on must carry a valid CSRF token.
app.use('/api', doubleCsrfProtection);

app.use('/api/auth', authRoutes);
app.use('/api/entries', requireAuth, entriesRoutes);
app.use('/api/timer', requireAuth, timerRoutes);
app.use('/api/account', requireAuth, accountRoutes);
app.use('/api/admin', requireAuth, requireAdmin, adminRoutes);
app.use('/api/update', requireAuth, updateRoutes);

app.use((err, req, res, next) => {
  if (err && err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Sicherheitstoken ungueltig oder abgelaufen. Seite neu laden.' });
  }
  // Fehler aus express.json(): zu grosser oder ungueltiger Datensatz.
  // Ohne diese Faelle wuerde daraus ein wenig hilfreicher "Interner Fehler".
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Die gesendeten Daten sind zu gross.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Ungueltige Anfrage (fehlerhaftes JSON).' });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Interner Fehler.' });
});

// --- Seiten-Zugriffskontrolle (serverseitig, nicht nur im Client-JS) ---
// Damit "/" und die geschuetzten Seiten IMMER korrekt weiterleiten, auch
// bevor/ohne dass clientseitiges JavaScript dazu kommt zu laufen.
const getSessionUserStmt = db.prepare(
  'SELECT id, role, is_apprentice FROM users WHERE id = ? AND active = 1'
);
function sessionUser(req) {
  if (!req.session || !req.session.userId) return null;
  return getSessionUserStmt.get(req.session.userId) || null;
}

const PROTECTED_PAGES = new Set([
  '/index.html', '/account.html', '/admin.html', '/wochenbericht.html', '/uebersicht.html',
]);

app.get('/', (req, res) => {
  res.redirect(sessionUser(req) ? '/index.html' : '/login.html');
});

app.use((req, res, next) => {
  if (req.path === '/login.html') {
    if (sessionUser(req)) return res.redirect('/index.html');
    return next();
  }
  if (PROTECTED_PAGES.has(req.path)) {
    const user = sessionUser(req);
    if (!user) return res.redirect('/login.html');
    if (req.path === '/admin.html' && user.role !== 'admin') return res.redirect('/index.html');
    if (req.path === '/wochenbericht.html' && !user.is_apprentice) return res.redirect('/index.html');
  }
  next();
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: false }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html')));

// Aufbewahrungsfrist des Protokolls durchsetzen und Papierkorb leeren:
// einmal beim Start, danach taeglich.
runRetentionCleanup();
updater.startSchedule();
setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000).unref();

const listenArgs = config.host ? [config.port, config.host] : [config.port];
const server = app.listen(...listenArgs, () => {
  if (localMode.announce()) return;
  // eslint-disable-next-line no-console
  console.log(`Zeiterfassung laeuft auf Port ${config.port} (${config.nodeEnv}).`);
  // eslint-disable-next-line no-console
  console.log(
    `Konfigurierte Adressen (Passkeys funktionieren nur unter diesen): ${[...config.originByHost.keys()].join(', ')}`
  );
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(
      `\nPort ${config.port} ist belegt. Laeuft die Zeiterfassung schon (anderes Fenster)? ` +
        'Sonst einen anderen Port waehlen, z.B. PORT=4712.\n'
    );
    process.exit(1);
  }
  throw err;
});
