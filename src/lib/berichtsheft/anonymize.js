'use strict';

// Lokale Anonymisierung der Eintragstexte. Laeuft vollstaendig im eigenen Prozess und VOR jedem
// Aufruf eines KI-Anbieters; nur das Ergebnis darf das Geraet verlassen.
//
// Was sicher entfernt wird (Muster): Datum, Uhrzeit, Wochentag, Kalenderwoche, relative Zeitangaben
// ("gestern"), URLs, E-Mail-Adressen, IP-Adressen, Telefonnummern und Ticketnummern.
// Personen-, Kunden- und Firmennamen ersetzt ein Woerterbuch (vom Nutzer gepflegt). Weil im
// Deutschen alle Nomen gross geschrieben werden, kann Software unbekannte Namen nicht sicher
// erkennen: findCandidates() liefert deshalb nur VERDAECHTIGE Woerter, ueber die der Nutzer einmal
// entscheidet (Name oder harmloser Begriff) - die Antwort wird gespeichert.

const KIND_PHRASE = {
  person: 'ein Kollege',
  kunde: 'ein Kunde',
  firma: 'ein Unternehmen',
};
const KINDS = Object.keys(KIND_PHRASE);

// Typische Kuerzel mit Bindestrich/Ziffern, die KEINE Ticketnummern sind (SHA-256, ISO-27001 ...).
const TECH_PREFIXES = new Set([
  'SHA', 'AES', 'RSA', 'TLS', 'SSL', 'UTF', 'ISO', 'DIN', 'IEEE', 'RFC', 'CAT', 'USB', 'DDR', 'SATA',
  'IPV', 'OSI', 'EN', 'PCI', 'RAID', 'WPA', 'WEP', 'DES', 'MD', 'CVE', 'ECC', 'HTTP', 'HTML', 'PEP',
  'MP', 'BSI', 'LTS', 'WIN', 'VLAN', 'NAT', 'ARM', 'GPT', 'CPU', 'GPU', 'SSD', 'HDD',
]);

// Gaengige Abkuerzungen, die nicht als Firmennamen gemeldet werden sollen.
const COMMON_ACRONYMS = new Set([
  'LAN', 'WAN', 'WLAN', 'VPN', 'DNS', 'DHCP', 'IP', 'TCP', 'UDP', 'HTTP', 'HTTPS', 'SSH', 'FTP', 'SMTP',
  'IMAP', 'POP', 'USB', 'PDF', 'CSV', 'XML', 'JSON', 'HTML', 'CSS', 'SQL', 'API', 'URL', 'GUI', 'CLI',
  'PC', 'PCs', 'CPU', 'GPU', 'RAM', 'SSD', 'HDD', 'BIOS', 'UEFI', 'RAID', 'NAS', 'SAN', 'VM', 'VMs',
  'OS', 'IT', 'EDV', 'ERP', 'CRM', 'AD', 'LDAP', 'SSO', 'MFA', 'ITIL', 'DSGVO', 'ISO', 'DIN', 'BSI',
  'IHK', 'AZUBI', 'KW', 'SLA', 'FAQ', 'USV', 'UPS', 'PoE', 'VLAN', 'NAT', 'BGP', 'OSPF', 'MAC', 'SNMP',
  'RDP', 'ISP', 'CDN', 'SaaS', 'IaaS', 'PaaS', 'RZ', 'DC', 'KVM', 'BYOD', 'MDM', 'ISDN', 'DSL', 'FTTH',
  'LTE', 'GPS', 'RFID', 'QR', 'PIN', 'TAN', 'OK', 'ISBN', 'GmbH', 'AG', 'KG', 'UG', 'SE', 'MS', 'AWS',
  'GCP', 'IAM', 'CI', 'CD', 'SCSI', 'SATA', 'HDMI', 'DVI', 'RJ', 'OSI', 'ARP', 'ICMP', 'NTP', 'TLS', 'SSL',
]);

// Haeufige deutsche Vornamen (nur eindeutige; Woerter wie "Mark" oder "Rose" fehlen bewusst).
const FIRST_NAMES = new Set((
  'Alexander Andreas Anna Annika Anja Antje Armin Arne Bastian Benedikt Benjamin Bernd Birgit Björn ' +
  'Carsten Christian Christina Christoph Claudia Daniel Daniela David Dennis Dieter Dirk Dominik ' +
  'Elena Elisabeth Emil Emma Eric Erik Eva Fabian Felix Florian Frank Franziska Friedrich Gabriele ' +
  'Georg Gerd Hannah Hans Heike Heiko Helmut Henrik Holger Ines Ingo Jan Jana Janina Jannik Jens ' +
  'Jessica Joachim Johanna Johannes Jonas Julia Julian Jürgen Katharina Katrin Kai Karin Karsten ' +
  'Kerstin Klaus Kristin Lars Laura Lena Leon Lisa Lukas Maik Manuel Marcel Marco Maria Marie Marius ' +
  'Markus Martin Matthias Maximilian Melanie Michael Michaela Monika Nadine Nico Nicole Niklas Nils ' +
  'Nina Oliver Pascal Patrick Paul Peter Petra Philipp Rainer Ralf Rene René Robert Roland Sabine ' +
  'Sandra Sarah Sascha Sebastian Silke Simon Sina Sonja Stefan Stefanie Stephan Susanne Sven Sophie ' +
  'Svenja Thomas Thorsten Tim Timo Tobias Tom Torsten Ulrich Ursula Uwe Vanessa Verena Viktoria ' +
  'Volker Walter Werner Wolfgang Yvonne'
).split(/\s+/));

const MONTHS = 'Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember';
const WEEKDAYS = 'Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonnabend|Sonntag';

const RE = {
  url: /https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+/giu,
  email: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/giu,
  ipv4: /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?(?![\d.]*\d)/gu,
  phone: /(?<![\p{L}\p{N}])(?:\+|00)\d[\d\s/().-]{6,}\d|(?<![\p{L}\p{N}])0\d{2,5}[\s/-]\d{3,}[\d\s-]*\d/gu,
  isoDate: /\b\d{4}-\d{2}-\d{2}\b/gu,
  dotDate: new RegExp(
    `(?<![\\p{L}\\p{N}])\\d{1,2}\\.\\s?(?:\\d{1,2}\\.|(?:${MONTHS}))(?:\\s?\\d{2,4})?(?![\\p{L}\\p{N}])`, 'giu'),
  monthName: new RegExp(`(?:\\b(?:im|seit|bis|ab|vom|Anfang|Ende|Mitte)\\s+)?\\b(?:${MONTHS})(?:\\s+\\d{4})?\\b`, 'gu'),
  week: /\b(?:KW|Kalenderwoche)\s?\d{1,2}\b/giu,
  time: /(?:\b(?:um|ab|bis|gegen|von)\s+)?(?:\b\d{1,2}[:.]\d{2}\s?Uhr\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?Uhr\b)/giu,
  weekday: new RegExp(
    `(?:\\b(?:am|vom|bis|ab|seit|jeden|letzten|diesen|n(?:ä|ae)chsten)\\s+)?\\b(?:${WEEKDAYS})(?:s|e|en)?\\b`, 'giu'),
  weekdayAbbr: /(?<![\p{L}])(?:Mo|Di|Mi|Do|Fr|Sa|So)\.(?=\s|$|,)/gu,
  relative: /\b(?:heute|gestern|vorgestern|übermorgen|uebermorgen)\b/giu,
  ticket: /(?<![\p{L}\p{N}-])[A-Z][A-Z0-9]{1,9}-\d{1,6}(?![\p{L}\p{N}-])/gu,
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Raeumt Leerzeichen und verwaiste Satzzeichen nach dem Entfernen von Textteilen auf. */
function tidy(text) {
  let t = text;
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/\(\s*[,;:\s]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?)])/g, '$1')
      .replace(/([,;:])(\s*[,;:])+/g, '$1')
      .replace(/\b(ein (?:Kollege|Kunde|Unternehmen))(?:\s+\1\b)+/giu, '$1')
      .replace(/^[\s,;:\-–—/]+|[\s,;:\-–—/]+$/g, '')
      // übrig gebliebene Bindewörter am Anfang/Ende ("... und" nach entferntem Datum)
      .replace(/(?:^|[\s,;])(?:und|oder|sowie|mit|am|um|bei|von|bis|ab)\s*$/iu, '')
      .replace(/^(?:und|oder|sowie)\s+/iu, '')
      .trim();
  }
  return t;
}

function squash(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function isAllowed(term, vocab) {
  const t = term.toLowerCase();
  return (vocab.allow || []).some((a) => a.toLowerCase() === t);
}

/** Woerterbuch normalisieren und nach Laenge absteigend sortieren (laengster Treffer zuerst). */
function nameList(vocab) {
  return (vocab.names || [])
    .filter((n) => n && typeof n.term === 'string' && n.term.trim() && KIND_PHRASE[n.kind] && !isAllowed(n.term, vocab))
    .map((n) => ({ term: n.term.trim(), kind: n.kind }))
    .sort((a, b) => b.term.length - a.term.length);
}

function stripPatterns(text, { ownKeys = [] } = {}) {
  let t = text;
  for (const key of ownKeys) {
    if (key) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(key)}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  t = t.replace(RE.url, ' ').replace(RE.email, ' ').replace(RE.phone, ' ');
  t = t.replace(RE.isoDate, ' ').replace(RE.dotDate, ' ').replace(RE.week, ' ');
  t = t.replace(RE.time, ' ').replace(RE.ipv4, ' ');
  t = t.replace(RE.weekday, ' ').replace(RE.weekdayAbbr, ' ').replace(RE.relative, ' ').replace(RE.monthName, ' ');
  t = t.replace(RE.ticket, (m) => (TECH_PREFIXES.has(m.split('-')[0]) ? m : ' '));
  return t;
}

/**
 * Anonymisiert einen Text.
 * @param {string} text
 * @param {{names?: {term:string, kind:string}[], allow?: string[]}} vocab
 * @param {{ownKeys?: string[]}} [opts] Ticketnummern des Eintrags (werden immer entfernt)
 * @returns {{text: string, replaced: {from:string, kind:string}[]}}
 */
function anonymizeText(text, vocab = {}, opts = {}) {
  const replaced = [];
  const original = String(text || '');
  let t = original;
  // Zuerst URLs/E-Mails/Telefon raus (Namen koennen darin vorkommen), dann das Woerterbuch.
  t = t.replace(RE.url, ' ').replace(RE.email, ' ').replace(RE.phone, ' ');
  for (const { term, kind } of nameList(vocab)) {
    const body = escapeRe(term).replace(/\s+/g, '\\s+');
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:(?:Herrn?|Frau|Hr\\.|Fr\\.|Dr\\.|Prof\\.)\\s+)?(?:${body})(?:s|es|n)?(?![\\p{L}\\p{N}])`, 'giu');
    t = t.replace(re, (m) => {
      replaced.push({ from: m, kind });
      return ` ${KIND_PHRASE[kind]} `;
    });
  }
  t = stripPatterns(t, opts);
  const changed = replaced.length > 0 || squash(t) !== squash(original);
  return { text: tidy(t), replaced, changed };
}

/**
 * Verdaechtige Woerter, die nicht im Woerterbuch/der Erlaubnisliste stehen. Es wird NICHT ersetzt.
 * @returns {{word: string, reason: string}[]}
 */
function findCandidates(text, vocab = {}) {
  const found = new Map();
  const known = new Set([
    ...nameList(vocab).map((n) => n.term.toLowerCase()),
    ...(vocab.allow || []).map((a) => a.toLowerCase()),
  ]);
  const add = (word, reason) => {
    const w = word.trim();
    if (!w || known.has(w.toLowerCase()) || found.has(w)) return;
    const parts = w.split(/[\s-]+/).map((x) => x.toLowerCase());
    if (parts.some((x) => known.has(x) || TECH_PREFIXES.has(x.toUpperCase()))) return;
    found.set(w, reason);
  };

  const ctx = /(?<![\p{L}])(?<!ein\s)(?:Herrn?|Frau|Hr\.|Fr\.|Kollege|Kollegin|Kunde|Kunden|Kundin|Firma|Fa\.|Mitarbeiter|Mitarbeiterin|Chef|Chefin|Ausbilder|Ausbilderin)\s+(\p{Lu}[\p{L}-]+(?:\s+\p{Lu}[\p{L}-]+)?)/gu;
  for (const m of text.matchAll(ctx)) add(m[1], 'steht hinter Herr/Frau/Kunde/Firma');

  const legal = /((?:\p{Lu}[\p{L}&.-]*\s+){1,3})(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|UG|mbH|e\.\s?V\.|SE|GbR|OHG)(?![\p{L}])/gu;
  for (const m of text.matchAll(legal)) add(m[1], 'Firmenname (Rechtsform)');

  const words = [...text.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}-]*(?![\p{L}\p{N}])/gu)];
  for (let i = 0; i < words.length; i++) {
    const w = words[i][0];
    if (FIRST_NAMES.has(w)) {
      const next = words[i + 1];
      const adjacent = next && text.slice(words[i].index + w.length, next.index).trim() === '';
      if (adjacent && !COMMON_ACRONYMS.has(next[0])) add(`${w} ${next[0]}`, 'Vor- und Nachname');
      else add(w, 'Vorname');
    }
  }
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])\p{Lu}{3,}(?![\p{L}\p{N}])/gu)) {
    if (!COMMON_ACRONYMS.has(m[0]) && !COMMON_ACRONYMS.has(m[0].toUpperCase())) add(m[0], 'unbekanntes Kuerzel (Firma/Kunde?)');
  }
  return [...found.entries()].map(([word, reason]) => ({ word, reason }));
}


// Gross geschriebene Funktionswoerter und die eigenen Platzhalter: nie als "unbekanntes Wort" melden.
const STOP_WORDS = new Set((
  'der die das den dem des ein eine einen einem einer und oder mit fuer für von bei nach auf in im am an zu zum zur ' +
  'ich wir es sie er kollege kunde unternehmen neu neue neuer neues alle alles erste ersten herr herrn frau tel fax ' +
  'montag dienstag mittwoch donnerstag freitag samstag sonntag ' +
  // haeufige IT-/Buero-Begriffe, damit die Rueckfrage nach unbekannten Woertern kurz bleibt
  'server update updates backup backups drucker passwort passwörter netzwerk switch router firewall konfiguration ' +
  'installation einrichtung support ticket tickets rechner laptop notebook monitor software hardware datenbank ' +
  'benutzer benutzerkonto konto konten berechtigung berechtigungen rechnung rechnungen lieferant kunden ' +
  'dokumentation anleitung wiki schulung besprechung meeting termin projekt aufgabe aufgaben problem probleme ' +
  'fehler fehlersuche analyse test tests wartung monitoring protokoll protokolle system systeme programm programme ' +
  'daten datei dateien ordner verzeichnis freigabe laufwerk speicher festplatte arbeitsplatz arbeitsplätze ' +
  'telefon smartphone tablet mail mails postfach kalender lizenz lizenzen zertifikat zertifikate skript skripte ' +
  'webseite website anwendung anwendungen dienst dienste prozess prozesse umgebung version versionen release ' +
  'unterricht berufsschule thema themen grundlagen lernfeld prüfung klausur hausaufgabe hausaufgaben ' +
  'subnetting routing vlan modell netzplan protokoll adressierung verkabelung patchen'
).split(/\s+/));

/**
 * Alle gross geschriebenen Woerter, ueber die der Nutzer noch nie entschieden hat. Im Deutschen sind
 * das vor allem normale Nomen - aber so faellt kein Name unbemerkt durch, nur weil er in keinem
 * Satzbau-Muster steht. Einmal bestaetigte Woerter ("reviewed") kommen nicht wieder.
 */
function findUnreviewedWords(text, vocab = {}, reviewed = []) {
  const known = new Set([
    ...nameList(vocab).flatMap((n) => [n.term.toLowerCase(), ...n.term.toLowerCase().split(/\s+/)]),
    ...(vocab.allow || []).map((a) => a.toLowerCase()),
    ...reviewed.map((r) => String(r).toLowerCase()),
  ]);
  const out = new Map();
  for (const m of String(text || '').matchAll(/(?<![\p{L}\p{N}])\p{Lu}\p{L}{2,}(?![\p{L}\p{N}])/gu)) {
    const w = m[0];
    const lower = w.toLowerCase();
    if (known.has(lower) || STOP_WORDS.has(lower) || COMMON_ACRONYMS.has(w) || COMMON_ACRONYMS.has(w.toUpperCase())) continue;
    if (TECH_PREFIXES.has(w.toUpperCase())) continue;
    if (!out.has(lower)) out.set(lower, w);
  }
  return [...out.values()];
}

/**
 * Prueft einen (KI-)Text auf Reste, die nicht im Ergebnis stehen duerfen. Ersetzt Namen und
 * entfernt Datums-/Ticketmuster erneut; "changed" zeigt, ob etwas gefunden wurde.
 */
function scrubOutput(text, vocab = {}) {
  let changed = false;
  const lines = String(text || '').split('\n').map((line) => {
    const r = anonymizeText(line, vocab);
    if (r.changed) changed = true;
    return r.text;
  });
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), changed };
}

module.exports = {
  KIND_PHRASE,
  KINDS,
  anonymizeText,
  findCandidates,
  findUnreviewedWords,
  scrubOutput,
  tidy,
  COMMON_ACRONYMS,
};
