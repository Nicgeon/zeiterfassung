'use strict';

// Hilfen der Oberfläche (public/js/util.js), im Node-Kontext geladen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUtil(tz) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'util.js'), 'utf8'), ctx);
  return ctx;
}
const u = loadUtil();

test('Datum: Tage addieren über Monats-, Jahres- und Schaltjahresgrenzen', () => {
  assert.equal(u.addDaysISO('2026-12-30', 3), '2027-01-02');
  assert.equal(u.addDaysISO('2028-02-28', 1), '2028-02-29');
  assert.equal(u.addDaysISO('2026-03-01', -1), '2026-02-28');
  assert.equal(u.addDaysISO('2026-03-28', 2), '2026-03-30', 'über die Zeitumstellung hinweg');
  assert.equal(u.addDaysISO('2026-10-24', 2), '2026-10-26');
});

test('Datum: Wochentag, Montag der Woche, Kalenderwoche nach ISO 8601', () => {
  assert.equal(u.weekdayIndexISO('2026-11-23'), 0, 'Montag');
  assert.equal(u.weekdayIndexISO('2026-11-22'), 6, 'Sonntag');
  assert.equal(u.mondayOfISO('2026-11-22'), '2026-11-16');
  assert.equal(u.mondayOfISO('2027-01-01'), '2026-12-28');
  assert.equal(u.isoWeekOf('2026-11-20'), 47);
  assert.equal(u.isoWeekOf('2026-01-01'), 1);
  assert.equal(u.isoWeekOf('2027-01-01'), 53, '2026 hat 53 Wochen');
  assert.equal(u.isoWeekOf('2027-01-04'), 1);
});
