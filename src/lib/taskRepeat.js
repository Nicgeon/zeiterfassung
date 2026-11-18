'use strict';

// Wiederkehrende Aufgaben: "alle N Tage/Wochen/Monate", gerechnet ab dem Fälligkeitstermin ("due")
// oder ab dem Tag des Abhakens ("done").

const { addDays, isValidDate } = require('./dates');

const UNITS = ['day', 'week', 'month'];
const MODES = ['due', 'done'];

/** Prüft und bereinigt eine Wiederholung; null = keine. Wirft bei ungültiger Angabe. */
function normalizeRepeat(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === false) return null;
  const every = Number(raw.every);
  if (!Number.isInteger(every) || every < 1 || every > 365) throw new Error('Wiederholung: Abstand muss zwischen 1 und 365 liegen.');
  if (!UNITS.includes(raw.unit)) throw new Error('Wiederholung: Einheit muss Tag, Woche oder Monat sein.');
  const mode = raw.mode === undefined ? 'due' : raw.mode;
  if (!MODES.includes(mode)) throw new Error('Wiederholung: ungültiger Modus.');
  return { every, unit: raw.unit, mode };
}

/** Monate addieren; der Tag wird auf das Monatsende gekürzt (31. Jan + 1 Monat = 28./29. Feb). */
function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const p = (n) => String(n).padStart(2, '0');
  return `${ny}-${p(nm + 1)}-${p(Math.min(d, last))}`;
}

function step(dateStr, repeat) {
  if (repeat.unit === 'day') return addDays(dateStr, repeat.every);
  if (repeat.unit === 'week') return addDays(dateStr, repeat.every * 7);
  return addMonths(dateStr, repeat.every);
}

/**
 * Nächster Fälligkeitstermin nach dem Erledigen.
 * - "due": ab dem bisherigen Termin; verpasste Termine werden übersprungen (nie ein Termin in der Vergangenheit)
 * - "done": ab dem Erledigt-Tag
 */
function nextDue(dueDate, repeat, doneDate) {
  if (!repeat || !isValidDate(doneDate)) return null;
  let next;
  if (repeat.mode === 'done' || !dueDate || !isValidDate(dueDate)) {
    next = step(doneDate, repeat);
  } else {
    next = step(dueDate, repeat);
    let guard = 0;
    while (next <= doneDate && guard++ < 1000) next = step(next, repeat);
  }
  return next;
}

module.exports = { UNITS, MODES, normalizeRepeat, addMonths, nextDue };
