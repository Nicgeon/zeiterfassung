'use strict';

// Zeitraum fuer den Befehl "berichtsheft".
//   ohne Angabe : letzte abgeschlossene Kalenderwoche (Montag bis Sonntag)
//   --von allein: bis zum Sonntag der Woche von "von"
//   --bis allein: ab dem Montag der Woche von "bis"
//   beide       : genau dieser Zeitraum

const { addDays, mondayOf, isValidDate, todayLocal, isoWeek } = require('../dates');

const MAX_DAYS = 62;

function lastCalendarWeek(today = todayLocal()) {
  const from = addDays(mondayOf(today), -7);
  return { from, to: addDays(from, 6) };
}

function resolvePeriod({ von, bis } = {}, today = todayLocal()) {
  for (const [name, value] of [['--von', von], ['--bis', bis]]) {
    if (value !== undefined && !isValidDate(value)) {
      throw new Error(`${name} erwartet ein gueltiges Datum im Format JJJJ-MM-TT (erhalten: "${value}").`);
    }
  }
  let from;
  let to;
  if (!von && !bis) {
    ({ from, to } = lastCalendarWeek(today));
  } else if (von && !bis) {
    from = von;
    to = addDays(mondayOf(von), 6);
    if (to < from) to = from;
  } else if (!von && bis) {
    to = bis;
    from = mondayOf(bis);
  } else {
    from = von;
    to = bis;
  }
  if (from > to) throw new Error('--von muss vor oder gleich --bis liegen.');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_DAYS) {
    throw new Error(`Der Zeitraum umfasst ${days} Tage, erlaubt sind hoechstens ${MAX_DAYS}.`);
  }
  return { from, to, days };
}

/** Dateiname-Teil, z. B. "2026-KW43" bei genau einer Kalenderwoche, sonst "2026-10-19_bis_2026-10-25". */
function periodLabel({ from, to }) {
  if (mondayOf(from) === from && addDays(from, 6) === to) {
    const { year, week } = isoWeek(from);
    return `${year}-KW${String(week).padStart(2, '0')}`;
  }
  return `${from}_bis_${to}`;
}

module.exports = { lastCalendarWeek, resolvePeriod, periodLabel, MAX_DAYS };
