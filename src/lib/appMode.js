'use strict';

// Programm-Modus im lokalen Betrieb: Die Zeiterfassung laeuft unsichtbar im Hintergrund und wird in einem
// eigenen App-Fenster angezeigt (siehe src/launcher.js). Damit nichts "ewig" weiterlaeuft, meldet sich
// die Seite regelmaessig ("Ping"); bleibt das Fenster zu, beendet sich der Server.

const express = require('express');

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
 * POST /api/app/quit                            -> beendet die Zeiterfassung
 * Ping ist ein GET (die Seite nutzt beim Verlassen fetch mit keepalive), darum prueft er den Herkunfts-
 * Header: Eine fremde Webseite darf den Server nicht per Link/Bild beenden koennen.
 */
function createRouter({ monitor, appMode, quit, setTimer = setTimeout }) {
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
  router.post('/quit', (req, res) => {
    res.json({ status: 'ok' });
    const t = setTimer(quit, 300);
    if (t && typeof t.unref === 'function') t.unref();
  });
  return router;
}

module.exports = { createIdleMonitor, createRouter };
