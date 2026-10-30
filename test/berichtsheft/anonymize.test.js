'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { anonymizeText, findCandidates, scrubOutput } = require('../../src/lib/berichtsheft/anonymize');

const vocab = {
  names: [
    { term: 'Müller', kind: 'person' },
    { term: 'Kloska Group', kind: 'kunde' },
    { term: 'BLG', kind: 'firma' },
  ],
  allow: ['Lini'],
};

test('entfernt Datum, Uhrzeit, Wochentag, KW und relative Angaben', () => {
  const r = anonymizeText('Am Montag, 19.10.2026 um 09:30 Uhr Backup geprüft (KW 43), gestern 2026-10-18 und 3. Oktober', vocab);
  assert.equal(r.text, 'Backup geprüft');
});

test('entfernt Wochentage in allen Formen, auch abgekürzt', () => {
  assert.equal(anonymizeText('Dienstags Drucker getauscht, Mo. Updates', vocab).text, 'Drucker getauscht, Updates');
  assert.equal(anonymizeText('bis Freitag Konfiguration', vocab).text, 'Konfiguration');
});

test('entfernt URLs, E-Mails, Telefonnummern und IP-Adressen', () => {
  const r = anonymizeText('Mail an max@firma.de, Tel. +49 421 123456, siehe https://intern.example/wiki, Gateway 192.168.0.1/24', vocab);
  assert.doesNotMatch(r.text, /@|https?:|\d{3,}|192/);
  assert.match(r.text, /Mail an/);
});

test('entfernt Ticketnummern, lässt aber SHA-256 und ISO-27001 stehen', () => {
  const r = anonymizeText('ITPKK-1182 SHA-256 Prüfsumme, ISO-27001 Audit, ABC-5 geklärt', vocab, { ownKeys: ['ITPKK-1182'] });
  assert.equal(r.text, 'SHA-256 Prüfsumme, ISO-27001 Audit, geklärt');
});

test('ersetzt Namen aus dem Wörterbuch samt Anrede und Genitiv-s', () => {
  const r = anonymizeText('Mit Herrn Müller Müllers Rechner geprüft, bei Kloska Group und BLG vor Ort', vocab);
  assert.equal(r.text, 'Mit ein Kollege Rechner geprüft, bei ein Kunde und ein Unternehmen vor Ort');
  assert.equal(r.replaced.length, 4);
});

test('Wörterbuch trifft nur ganze Wörter und ignoriert die Groß-/Kleinschreibung', () => {
  const r = anonymizeText('Müllerei und BLGX, aber MÜLLER schon', vocab);
  assert.equal(r.text, 'Müllerei und BLGX, aber ein Kollege schon');
});

test('Erlaubnisliste schützt Begriffe, auch wenn sie im Wörterbuch stehen', () => {
  const v = { names: [{ term: 'Lini', kind: 'firma' }], allow: ['lini'] };
  assert.equal(anonymizeText('Lini Update eingespielt', v).text, 'Lini Update eingespielt');
});

test('mehrere Platzhalter hintereinander werden zusammengefasst', () => {
  assert.equal(anonymizeText('Müller Müller Rechner', vocab).text, 'ein Kollege Rechner');
});

test('Reste wie leere Klammern und Satzzeichen werden aufgeräumt', () => {
  assert.equal(anonymizeText('Drucker (ITPKK-5, 12:30) neu installiert ,', vocab, { ownKeys: ['ITPKK-5'] }).text, 'Drucker neu installiert');
});

test('findCandidates meldet verdächtige Namen, aber nichts Bekanntes', () => {
  const text = 'Mit Frau Lena Schmidt von Acme GmbH gesprochen, Lini und SQL geprüft, Anna Beispiel, SHA-256, ABCD';
  const words = findCandidates(text, vocab).map((c) => c.word);
  assert.ok(words.includes('Lena Schmidt'));
  assert.ok(words.includes('Acme'));
  assert.ok(words.includes('Anna Beispiel'));
  assert.ok(words.includes('ABCD'));
  for (const harmless of ['Lini', 'SQL', 'SHA', 'SHA-256']) assert.ok(!words.includes(harmless), harmless);
});

test('findCandidates ignoriert die eigenen Platzhalter', () => {
  assert.deepEqual(findCandidates('Mit ein Kunde Update besprochen', vocab), []);
});

test('scrubOutput findet Namen, Wochentage und Ticketnummern in der KI-Antwort', () => {
  const r = scrubOutput('Am Dienstag wurde Müller geholfen. ITPKK-9 war ein Ticket.\nZweite Zeile.', vocab);
  assert.equal(r.changed, true);
  assert.doesNotMatch(r.text, /Dienstag|Müller|ITPKK/);
  assert.match(r.text, /Zweite Zeile\./);
});

test('scrubOutput lässt saubere Texte unverändert', () => {
  const r = scrubOutput('Es wurde ein Kunde beim Einrichten von Lini unterstützt.', vocab);
  assert.equal(r.changed, false);
});

test('scrubOutput: nach dem Entfernen von "Am Montag" bleiben ganze Sätze mit großem Anfang übrig', () => {
  const r = scrubOutput('Am Montag wurden die täglichen Aufgaben besprochen. Am Dienstag wurde ein Update eingespielt. Außerdem wurden Termine geprüft.', vocab);
  assert.equal(r.changed, true);
  assert.equal(r.text, 'Es wurden die täglichen Aufgaben besprochen. Es wurde ein Update eingespielt. Außerdem wurden Termine geprüft.');
});

test('polishSentences: Satzanfang groß, aber nicht nach Abkürzungen', () => {
  const { polishSentences } = require('../../src/lib/berichtsheft/anonymize');
  assert.equal(polishSentences('wurden Mails gelesen. emails wurden geprüft, z. B. das Postfach, ca. zehn Stück.'), 'Es wurden Mails gelesen. Emails wurden geprüft, z. B. das Postfach, ca. zehn Stück.');
  assert.equal(polishSentences('Saubere Sätze bleiben. So wie sie sind.'), 'Saubere Sätze bleiben. So wie sie sind.');
});
