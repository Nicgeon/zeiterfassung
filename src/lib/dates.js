'use strict';

// Kleine Datumshilfen auf Basis von "JJJJ-MM-TT"-Strings (ohne Zeitzonenprobleme).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Montag der Woche, in der das Datum liegt. */
function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mo=0 ... So=6
  return addDays(dateStr, -weekday);
}

/** Ist das ein echtes Kalenderdatum (kein 2026-02-31)? */
function isValidDate(dateStr) {
  if (!DATE_RE.test(dateStr || '')) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Heutiges Datum in lokaler Zeit als "JJJJ-MM-TT". */
function todayLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Kalenderwoche nach ISO 8601: { year, week } (das Jahr ist das der ISO-Woche). */
function isoWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = (date.getUTCDay() + 6) % 7; // Mo=0
  date.setUTCDate(date.getUTCDate() - day + 3); // Donnerstag der Woche
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 86400000));
  return { year, week };
}

module.exports = { DATE_RE, addDays, mondayOf, isValidDate, todayLocal, isoWeek };
