'use strict';

// Berichtsheft-Text (Weboberflaeche): Einstellungen, Vorschau, Klaerung unbekannter Woerter, Erzeugen.
// Die Rechenarbeit liegt in src/lib/berichtsheft/service.js (dieselbe wie im Befehl "berichtsheft").

const express = require('express');
const rateLimit = require('express-rate-limit');
const { makeStore } = require('../lib/berichtsheft/store');
const providers = require('../lib/berichtsheft/providers');
const service = require('../lib/berichtsheft/service');
const { PROVIDERS, resolveKey, resolveModel } = require('../lib/berichtsheft/store');

/**
 * @param {{db: object, encryptField: Function, decryptField: Function, audit?: Function, localMode?: boolean,
 *          env?: object, providers?: {generate: Function, listModels: Function}}} deps
 */
function createRouter(deps) {
  const router = express.Router();
  const store = makeStore(deps.db, deps);
  const env = deps.env || process.env;
  const api = deps.providers || providers;
  const audit = deps.audit || (() => {});

  // Externe KI-Anbieter lassen sich serverweit abschalten; eigene Adressen (Server-seitige Anfragen)
  // sind im Serverbetrieb standardmaessig gesperrt, weil sie sonst interne Dienste ansprechen koennten.
  const flags = {
    aiAllowed: env.BERICHTSHEFT_KI !== 'aus',
    customUrlAllowed: !!deps.localMode || String(env.BERICHTSHEFT_ALLOW_CUSTOM_URL || '').toLowerCase() === 'true',
  };

  const generateLimiter = rateLimit({
    windowMs: 60_000,
    limit: 6,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `bh:${req.user.id}`,
    message: { error: 'Zu viele Anfragen. Bitte kurz warten.' },
  });

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof service.ServiceError) return res.status(err.status).json({ error: err.message, ...err.extra });
      if (err && err.name === 'ProviderError') return res.status(502).json({ error: err.message });
      if (err && /Datum|Zeitraum|JJJJ|--von|--bis/.test(err.message || '')) return res.status(400).json({ error: err.message });
      // eslint-disable-next-line no-console
      console.error('[berichtsheft]', err && err.message);
      res.status(500).json({ error: 'Unerwarteter Fehler beim Erzeugen des Berichtsheft-Textes.' });
    }
  };

  const view = (config) => service.describeSettings(config, { env, ...flags });

  router.get('/settings', wrap((req, res) => res.json(view(store.loadConfig(req.user.id)))));

  router.put('/settings', wrap((req, res) => {
    const next = service.applySettings(store.loadConfig(req.user.id), req.body, flags);
    store.saveConfig(req.user.id, next);
    audit(req.user.id, 'berichtsheft_settings_changed', `provider=${next.provider}`, req.ip);
    res.json(view(next));
  }));

  /** Schluessel pruefen: listet die Modelle des Anbieters. */
  router.post('/models', generateLimiter, wrap(async (req, res) => {
    const config = store.loadConfig(req.user.id);
    const provider = (req.body && req.body.provider) || config.provider;
    if (!PROVIDERS[provider]) throw new service.ServiceError('Unbekannter Anbieter.');
    if (!flags.aiAllowed && provider !== 'kompatibel') throw new service.ServiceError('Externe KI-Anbieter sind auf diesem Server abgeschaltet.', 403);
    if (provider === 'kompatibel' && !flags.customUrlAllowed) throw new service.ServiceError('Eigene Adressen sind auf diesem Server nicht erlaubt.', 403);
    const apiKey = resolveKey(config, provider, env);
    if (!apiKey && provider !== 'kompatibel') throw new service.ServiceError('Es ist noch kein API-Schlüssel hinterlegt.');
    const models = await api.listModels({ provider, apiKey, baseUrl: config.baseUrls[provider] });
    const current = resolveModel(config, provider);
    res.json({ models: models.sort(), current, currentFound: models.includes(current) });
  }));

  router.post('/prepare', wrap((req, res) => {
    const { from, to } = req.body || {};
    res.json(service.prepare({ store, userId: req.user.id, from, to, env, flags }));
  }));

  router.post('/review', wrap((req, res) => {
    const { decisions, names, from, to } = req.body || {};
    if (decisions !== undefined && !Array.isArray(decisions)) throw new service.ServiceError('Ungültige Eingabe.');
    const next = service.applyReview(store.loadConfig(req.user.id), decisions, names);
    store.saveConfig(req.user.id, next);
    res.json(service.prepare({ store, userId: req.user.id, from, to, env, flags }));
  }));

  router.post('/generate', generateLimiter, wrap(async (req, res) => {
    const { from, to, hash, mode } = req.body || {};
    if (mode !== 'lokal' && mode !== 'ki') throw new service.ServiceError('Bitte "ki" oder "lokal" angeben.');
    const result = await service.generate({
      store, userId: req.user.id, from, to, hash, mode, env, flags, generateImpl: api.generate,
    });
    audit(req.user.id, 'berichtsheft_generated', `${result.mode === 'lokal' ? 'ohne KI' : 'KI'}, ${result.label}`, req.ip);
    res.json(result);
  }));

  return router;
}

module.exports = { createRouter };
