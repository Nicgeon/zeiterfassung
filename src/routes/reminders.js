'use strict';

// Einstellungen der Erinnerungen (Timer läuft lange, lange nichts erfasst, Feierabend, fällige Aufgaben) und eine
// Testbenachrichtigung. Die Erinnerungen selbst laufen im Server (workReminders.js, taskReminders.js).

const express = require('express');

function createRouter({ reminders, notify, active }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ settings: reminders.settings(req.user.id), active });
  });

  router.put('/', (req, res) => {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Ungültige Eingabe.' });
    res.json({ settings: reminders.save(req.user.id, body), active });
  });

  router.post('/test', (req, res) => {
    if (!active) return res.status(409).json({ error: 'Erinnerungen gibt es nur im Programm auf dem eigenen Rechner.' });
    const ok = notify({ title: 'Zeiterfassung', body: 'So sehen die Erinnerungen aus.' });
    res.json({ ok });
  });

  return router;
}

module.exports = { createRouter };
