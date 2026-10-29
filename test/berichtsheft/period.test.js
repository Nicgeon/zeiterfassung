'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lastCalendarWeek, resolvePeriod, periodLabel } = require('../../src/lib/berichtsheft/period');
const { isoWeek, isValidDate } = require('../../src/lib/dates');

test('Standard ist die letzte abgeschlossene Kalenderwoche', () => {
  assert.deepEqual(lastCalendarWeek('2026-10-29'), { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(lastCalendarWeek('2026-10-26'), { from: '2026-10-19', to: '2026-10-25' }); // Montag
  assert.deepEqual(lastCalendarWeek('2026-10-25'), { from: '2026-10-12', to: '2026-10-18' }); // Sonntag
});

test('Jahreswechsel', () => {
  assert.deepEqual(lastCalendarWeek('2027-01-04'), { from: '2026-12-28', to: '2027-01-03' });
  assert.deepEqual(lastCalendarWeek('2027-01-01'), { from: '2026-12-21', to: '2026-12-27' });
});

test('--von und --bis', () => {
  assert.deepEqual(resolvePeriod({ von: '2026-10-01', bis: '2026-10-09' }), { from: '2026-10-01', to: '2026-10-09', days: 9 });
  assert.deepEqual(resolvePeriod({ von: '2026-10-21' }).to, '2026-10-25');
  assert.deepEqual(resolvePeriod({ bis: '2026-10-21' }).from, '2026-10-19');
});

test('ungültige Eingaben', () => {
  assert.throws(() => resolvePeriod({ von: '2026-02-31' }), /Datum/);
  assert.throws(() => resolvePeriod({ von: '21.10.2026' }), /JJJJ-MM-TT/);
  assert.throws(() => resolvePeriod({ von: '2026-10-10', bis: '2026-10-01' }), /vor oder gleich/);
  assert.throws(() => resolvePeriod({ von: '2026-01-01', bis: '2026-12-31' }), /höchstens|hoechstens/);
});

test('Kalenderwochen nach ISO 8601', () => {
  assert.deepEqual(isoWeek('2026-10-19'), { year: 2026, week: 43 });
  assert.deepEqual(isoWeek('2026-12-28'), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek('2027-01-03'), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek('2027-01-04'), { year: 2027, week: 1 });
  assert.deepEqual(isoWeek('2021-01-03'), { year: 2020, week: 53 });
});

test('Beschriftung für Dateinamen', () => {
  assert.equal(periodLabel({ from: '2026-10-19', to: '2026-10-25' }), '2026-KW43');
  assert.equal(periodLabel({ from: '2026-10-20', to: '2026-10-25' }), '2026-10-20_bis_2026-10-25');
});

test('isValidDate', () => {
  assert.equal(isValidDate('2024-02-29'), true);
  assert.equal(isValidDate('2026-02-29'), false);
});
