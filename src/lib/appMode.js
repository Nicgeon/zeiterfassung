'use strict';

// Programm-Modus im lokalen Betrieb: Die Zeiterfassung laeuft unsichtbar im Hintergrund und wird in einem
// eigenen App-Fenster angezeigt (siehe src/launcher.js). Damit nichts "ewig" weiterlaeuft, meldet sich
// die Seite regelmaessig ("Ping"); bleibt das Fenster zu, beendet sich der Server.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { KINDS } = require('./launcherUtil');

/**
 * Leerlauf-Waechter. Erst nach dem ersten Ping aktiv (sonst wuerde ein Server beenden, dessen Fenster
 * noch gar nicht offen ist).
 *  - ping():    Fenster lebt -> Frist idleMs neu starten (grosszuegig: minimierte Fenster werden gedrosselt)
 *  - closing(): Seite wird verlassen -> kurze Frist closingMs; der naechste Ping (Seitenwechsel) hebt sie auf
 */
function createIdleMonitor({ idleMs = 150_000, closingMs = 10_000, onIdle, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let seen = false;
  let timer = null;
  const arm = (ms) => {
    clearTimer(timer);
    timer = setTimer(onIdle, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  return {
    ping() { seen = true; arm(idleMs); },
    closing() { if (seen) arm(closingMs); },
    stop() { clearTimer(timer); timer = null; },
    get seen() { return seen; },
  };
}

/**
 * GET  /api/app/ping?state=open|closing|probe   -> { appMode }
 * POST /api/app/window {kind:'main'|'mini'}      -> weiteres App-Fenster oeffnen (Starter) -> { opened }
 * POST /api/app/quit                            -> beendet die Zeiterfassung
 * Ping ist ein GET (die Seite nutzt beim Verlassen fetch mit keepalive), darum prueft er den Herkunfts-
 * Header: Eine fremde Webseite darf den Server nicht per Link/Bild beenden koennen.
 */
function createRouter({ monitor, appMode, quit, openWindow, settingsFile, currentBrowser, setTimer = setTimeout }) {
  const router = express.Router();
  router.get('/ping', (req, res) => {
    const site = req.get('sec-fetch-site');
    if (site && !['same-origin', 'none'].includes(site)) return res.status(403).json({ error: 'Nicht erlaubt.' });
    const state = String(req.query.state || 'open');
    if (appMode && monitor) {
      if (state === 'closing') monitor.closing();
      else if (state === 'open') monitor.ping();
    }
    res.set('Cache-Control', 'no-store');
    res.json({ appMode: !!appMode });
  });
  // Browser fuer das App-Fenster (gilt ab dem naechsten Start): nur Stichwoerter, nie ein Pfad aus dem Netz
  router.get('/settings', (req, res) => {
    let browser = 'auto';
    try { browser = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).browser || 'auto'; } catch { /* noch keine Datei */ }
    res.json({ browser, current: currentBrowser || null, options: ['auto', ...KINDS] });
  });
  router.put('/settings', (req, res) => {
    const browser = req.body && req.body.browser;
    if (!settingsFile || !['auto', ...KINDS].includes(browser)) return res.status(400).json({ error: 'Ungültige Angabe.' });
    let data = {};
    try { data = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* neu */ }
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ ...data, browser }, null, 2));
    res.json({ browser });
  });

  // Weiteres Programmfenster ("main" = gross, "mini") ueber den Starter oeffnen. Ohne Starter (Browser-Tab):
  // opened:false, die Seite oeffnet dann selbst ein Popup.
  router.post('/window', (req, res) => {
    const kind = req.body && req.body.kind;
    if (!['main', 'mini'].includes(kind)) return res.status(400).json({ error: 'Ungültige Angabe.' });
    res.json({ opened: !!(openWindow && openWindow(kind)) });
  });
  router.post('/quit', (req, res) => {
    res.json({ status: 'ok' });
    const t = setTimer(quit, 300);
    if (t && typeof t.unref === 'function') t.unref();
  });
  return router;
}

module.exports = { createIdleMonitor, createRouter };
