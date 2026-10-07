'use strict';

const express = require('express');
const updater = require('../lib/updater');
const config = require('../config');
const { audit } = require('../db');

const router = express.Router();

// Updates gibt es nur im lokalen Betrieb; im Servermodus wird neu gebaut und gestartet.
router.use((req, res, next) => {
  if (config.updateEnabled) return next();
  if (req.method === 'GET' && req.path === '/status') return res.json({ enabled: false });
  return res.status(403).json({ error: 'Updates sind nur im lokalen Betrieb verfuegbar.' });
});

router.get('/status', async (req, res) => {
  res.json(await updater.ensureChecked());
});

router.post('/check', async (req, res) => {
  res.json(await updater.check());
});

router.post('/apply', async (req, res) => {
  try {
    const result = await updater.apply();
    audit(req.user.id, 'update_installed', `${result.updated} Dateien (${config.updateBranch})`, req.ip);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
