'use strict';

const express = require('express');
const { db, audit } = require('../db');
const { encryptField, decryptField } = require('../lib/crypto');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Alle Abfragen blenden Eintraege im Papierkorb (deleted_at gesetzt) aus.
const listStmt = db.prepare(
  `SELECT * FROM entries
   WHERE user_id = ? AND work_date = ? AND deleted_at IS NULL
   ORDER BY start_time ASC, id ASC`
);
const rangeStmt = db.prepare(
  `SELECT * FROM entries
   WHERE user_id = ? AND work_date BETWEEN ? AND ? AND deleted_at IS NULL
   ORDER BY work_date ASC, start_time ASC, id ASC`
);
const getOwnStmt = db.prepare(
  'SELECT * FROM entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
);
const insertStmt = db.prepare(
  `INSERT INTO entries (user_id, work_date, start_time, end_time, duration_minutes, description_enc, jira_key)
   VALUES (@user_id, @work_date, @start_time, @end_time, @duration_minutes, @description_enc, @jira_key)`
);
const updateStmt = db.prepare(
  `UPDATE entries SET work_date=@work_date, start_time=@start_time, end_time=@end_time,
     duration_minutes=@duration_minutes, description_enc=@description_enc, jira_key=@jira_key,
     updated_at=datetime('now')
   WHERE id=@id AND user_id=@user_id AND deleted_at IS NULL`
);
const softDeleteStmt = db.prepare(
  "UPDATE entries SET deleted_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
);
const restoreStmt = db.prepare(
  `UPDATE entries SET deleted_at = NULL WHERE id = ? AND user_id = ?
     AND deleted_at IS NOT NULL AND deleted_at > datetime('now', '-120 seconds')`
);
const setTransferredStmt = db.prepare(
  "UPDATE entries SET transferred_to_jira = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
);
const suggestionStmt = db.prepare(
  `SELECT description_enc, jira_key FROM entries
   WHERE user_id = ? AND deleted_at IS NULL
   ORDER BY id DESC LIMIT 400`
);

const allOwnStmt = db.prepare(
  `SELECT * FROM entries WHERE user_id = ? AND deleted_at IS NULL
   ORDER BY work_date ASC, start_time ASC, id ASC`
);

const MAX_BULK_IDS = 500;
const MAX_IMPORT_BATCH = 50;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function validateAndCompute(body) {
  const { work_date, start_time, end_time, description } = body;
  if (!DATE_RE.test(work_date || '')) return { error: 'Ungueltiges Datum.' };
  if (!TIME_RE.test(start_time || '')) return { error: 'Ungueltige Startzeit (HH:MM).' };
  if (!TIME_RE.test(end_time || '')) return { error: 'Ungueltige Endzeit (HH:MM).' };
  if (!description || !String(description).trim()) return { error: 'Beschreibung darf nicht leer sein.' };
  if (String(description).length > 2000) return { error: 'Beschreibung ist zu lang (max. 2000 Zeichen).' };

  const duration = toMinutes(end_time) - toMinutes(start_time);
  if (duration <= 0) {
    return { error: 'Endzeit muss nach der Startzeit liegen (Eintraege ueber Mitternacht bitte aufteilen).' };
  }
  if (duration > 16 * 60) {
    return { error: 'Dauer wirkt unrealistisch hoch. Bitte pruefen.' };
  }

  let jiraKey = body.jira_key ? String(body.jira_key).trim().slice(0, 40) : null;
  if (jiraKey === '') jiraKey = null;

  return {
    work_date,
    start_time,
    end_time,
    duration_minutes: duration,
    description: String(description).trim(),
    jira_key: jiraKey,
  };
}

function serialize(row) {
  return {
    id: row.id,
    workDate: row.work_date,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMinutes: row.duration_minutes,
    description: decryptField(row.description_enc),
    jiraKey: row.jira_key,
    transferred: !!row.transferred_to_jira,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

// --- Wochenbericht (nur fuer Azubis) ------------------------------------
// Liefert bewusst NUR Datum und Aufgabentext, keine Uhrzeiten und keine
// Dauer - gedacht fuer den Wochenbericht in der Berufsschule.
router.get('/week', (req, res) => {
  if (!req.user.is_apprentice) {
    return res.status(403).json({ error: 'Der Wochenbericht steht nur Azubis zur Verfuegung.' });
  }
  const requested = DATE_RE.test(req.query.start || '') ? req.query.start : new Date().toISOString().slice(0, 10);
  const start = mondayOf(requested);
  const end = addDays(start, 6);

  const byDate = new Map();
  for (const row of rangeStmt.all(req.user.id, start, end)) {
    if (!byDate.has(row.work_date)) byDate.set(row.work_date, []);
    byDate.get(row.work_date).push({
      description: decryptField(row.description_enc),
      jiraKey: row.jira_key,
    });
  }

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    days.push({ date, tasks: byDate.get(date) || [] });
  }
  res.json({ start, end, days, taskCount: days.reduce((n, d) => n + d.tasks.length, 0) });
});

// --- Wochen-/Monatsuebersicht -------------------------------------------
router.get('/range', (req, res) => {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
    return res.status(400).json({ error: 'Bitte "from" und "to" als Datum (JJJJ-MM-TT) angeben.' });
  }
  if (from > to) return res.status(400).json({ error: '"from" muss vor "to" liegen.' });

  // Obergrenze, damit eine einzelne Abfrage nicht die gesamte Historie laedt.
  const spanDays = Math.round(
    (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000
  );
  if (!Number.isFinite(spanDays) || spanDays > 400) {
    return res.status(400).json({ error: 'Der Zeitraum darf hoechstens 400 Tage umfassen.' });
  }

  const entries = rangeStmt.all(req.user.id, from, to).map(serialize);

  const byDay = new Map();
  const byJira = new Map();
  for (const e of entries) {
    byDay.set(e.workDate, (byDay.get(e.workDate) || 0) + e.durationMinutes);
    const key = e.jiraKey || '(ohne Ticket)';
    byJira.set(key, (byJira.get(key) || 0) + e.durationMinutes);
  }

  res.json({
    from,
    to,
    entries,
    totalMinutes: entries.reduce((sum, e) => sum + e.durationMinutes, 0),
    openMinutes: entries.filter((e) => !e.transferred).reduce((sum, e) => sum + e.durationMinutes, 0),
    days: [...byDay.entries()].map(([date, minutes]) => ({ date, minutes })),
    jira: [...byJira.entries()]
      .map(([key, minutes]) => ({ key, minutes }))
      .sort((a, b) => b.minutes - a.minutes),
  });
});

// --- Vorschlaege fuer die Autovervollstaendigung ------------------------
// Beschreibungen liegen verschluesselt in der Datenbank, es kann also nicht
// per SQL gefiltert werden. Daher: die letzten Eintraege laden, entschluesseln
// und im Speicher filtern - haeufig genutzte Texte zuerst.
router.get('/suggestions', (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  const stats = new Map();

  for (const row of suggestionStmt.all(req.user.id)) {
    const description = decryptField(row.description_enc);
    if (!description) continue;
    const existing = stats.get(description);
    if (existing) {
      existing.count += 1;
      if (!existing.jiraKey && row.jira_key) existing.jiraKey = row.jira_key;
    } else {
      stats.set(description, { description, jiraKey: row.jira_key, count: 1, rank: stats.size });
    }
  }

  let list = [...stats.values()];
  if (query) list = list.filter((s) => s.description.toLowerCase().includes(query));
  list.sort((a, b) => b.count - a.count || a.rank - b.rank);

  res.json({
    suggestions: list.slice(0, 10).map((s) => ({ description: s.description, jiraKey: s.jiraKey })),
  });
});

// --- Tagesansicht ---------------------------------------------------------
router.get('/', (req, res) => {
  const date = DATE_RE.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
  const entries = listStmt.all(req.user.id, date).map(serialize);
  res.json({
    date,
    entries,
    totalMinutes: entries.reduce((sum, e) => sum + e.durationMinutes, 0),
  });
});

router.post('/', (req, res) => {
  const result = validateAndCompute(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });

  const info = insertStmt.run({
    user_id: req.user.id,
    work_date: result.work_date,
    start_time: result.start_time,
    end_time: result.end_time,
    duration_minutes: result.duration_minutes,
    description_enc: encryptField(result.description),
    jira_key: result.jira_key,
  });
  res.status(201).json({ entry: serialize(getOwnStmt.get(info.lastInsertRowid, req.user.id)) });
});

router.put('/:id', (req, res) => {
  const existing = getOwnStmt.get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });

  const result = validateAndCompute(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });

  updateStmt.run({
    id: existing.id,
    user_id: req.user.id,
    work_date: result.work_date,
    start_time: result.start_time,
    end_time: result.end_time,
    duration_minutes: result.duration_minutes,
    description_enc: encryptField(result.description),
    jira_key: result.jira_key,
  });
  res.json({ entry: serialize(getOwnStmt.get(existing.id, req.user.id)) });
});

/** Haken "nach Jira uebertragen" setzen oder entfernen. */
router.patch('/:id/transferred', (req, res) => {
  const value = req.body && req.body.transferred ? 1 : 0;
  const info = setTransferredStmt.run(value, req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
  res.json({ entry: serialize(getOwnStmt.get(req.params.id, req.user.id)) });
});

/** Mehrere Eintraege auf einmal als "nach Jira uebertragen" markieren (oder zuruecksetzen). */
router.patch('/transferred', (req, res) => {
  const { ids, transferred } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_IDS) {
    return res.status(400).json({ error: 'Ungueltige Auswahl.' });
  }
  const value = transferred ? 1 : 0;
  const apply = db.transaction(() => {
    let changed = 0;
    for (const id of ids) {
      if (!Number.isInteger(id)) continue;
      changed += setTransferredStmt.run(value, id, req.user.id).changes;
    }
    return changed;
  });
  res.json({ status: 'ok', updated: apply() });
});

// --- Datensicherung: eigene Eintraege exportieren / importieren -----------
// Der Export enthaelt die entschluesselten Texte (Klartext!). Importiert wird
// in kleinen Paketen, damit das globale Anfragelimit nicht greift.
router.get('/export', (req, res) => {
  const entries = allOwnStmt.all(req.user.id).map((row) => ({
    workDate: row.work_date,
    startTime: row.start_time,
    endTime: row.end_time,
    description: decryptField(row.description_enc),
    jiraKey: row.jira_key,
    transferred: !!row.transferred_to_jira,
  }));
  audit(req.user.id, 'data_exported', `${entries.length} Eintraege`, req.ip);
  res.json({ format: 'zeiterfassung-export', version: 1, exportedAt: new Date().toISOString(), entries });
});

router.post('/import', (req, res) => {
  const list = req.body && req.body.entries;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_IMPORT_BATCH) {
    return res.status(400).json({ error: `Pro Anfrage sind 1 bis ${MAX_IMPORT_BATCH} Eintraege erlaubt.` });
  }

  const prepared = [];
  for (const [index, raw] of list.entries()) {
    const item = raw || {};
    const result = validateAndCompute({
      work_date: item.workDate,
      start_time: item.startTime,
      end_time: item.endTime,
      description: item.description,
      jira_key: item.jiraKey,
    });
    if (result.error) {
      return res.status(400).json({ error: `Eintrag ${index + 1}: ${result.error}` });
    }
    prepared.push({ ...result, transferred: item.transferred ? 1 : 0 });
  }

  // Bereits vorhandene Eintraege (gleiches Datum, gleiche Zeit, gleicher Text) ueberspringen,
  // damit ein erneuter Import nichts doppelt anlegt.
  const dates = prepared.map((p) => p.work_date).sort();
  const known = new Set(
    rangeStmt.all(req.user.id, dates[0], dates[dates.length - 1]).map((row) =>
      [row.work_date, row.start_time, row.end_time, decryptField(row.description_enc), row.jira_key || ''].join('|')
    )
  );

  const run = db.transaction(() => {
    let imported = 0;
    for (const p of prepared) {
      const key = [p.work_date, p.start_time, p.end_time, p.description, p.jira_key || ''].join('|');
      if (known.has(key)) continue;
      known.add(key);
      const info = insertStmt.run({
        user_id: req.user.id,
        work_date: p.work_date,
        start_time: p.start_time,
        end_time: p.end_time,
        duration_minutes: p.duration_minutes,
        description_enc: encryptField(p.description),
        jira_key: p.jira_key,
      });
      if (p.transferred) setTransferredStmt.run(1, info.lastInsertRowid, req.user.id);
      imported += 1;
    }
    return imported;
  });
  const imported = run();
  if (imported > 0) audit(req.user.id, 'data_imported', `${imported} Eintraege`, req.ip);
  res.json({ imported, skipped: prepared.length - imported });
});

/** Loeschen legt zunaechst nur in den Papierkorb (fuer "Rueckgaengig"). */
router.delete('/:id', (req, res) => {
  const info = softDeleteStmt.run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
  res.json({ status: 'ok', undoSeconds: 30 });
});

router.post('/:id/restore', (req, res) => {
  const info = restoreStmt.run(req.params.id, req.user.id);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Eintrag kann nicht mehr wiederhergestellt werden.' });
  }
  res.json({ entry: serialize(getOwnStmt.get(req.params.id, req.user.id)) });
});

module.exports = router;
