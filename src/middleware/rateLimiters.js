'use strict';

const rateLimit = require('express-rate-limit');

function jsonLimitHandler(req, res) {
  res.status(429).json({ error: 'Zu viele Versuche. Bitte kurz warten und erneut versuchen.' });
}

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

const secondFactorLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

const passkeyCeremonyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

module.exports = { loginLimiter, secondFactorLimiter, passkeyCeremonyLimiter };
