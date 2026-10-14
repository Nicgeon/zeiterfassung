'use strict';

// Laufender Timer. Der Zustand liegt serverseitig, damit er weiterlaeuft,
// wenn der Browser-Tab geschlossen oder das Geraet gewechselt wird.
// Pro Person kann immer nur ein Timer laufen.

const express = require('express');
const { db } = require('../db');
const { encryptField, decryptField } = require('../lib/crypto');
const { convertTicketLinks } = require('../../public/js/tickets');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const getTimerStmt = db.prepare('SELECT * FROM active_timers WHERE user_id = ?');
const startTimerStmt = db.prepare(
  `INSERT INTO active_timers (user_id, started_at, work_date, start_time, description_enc, jira_key, carry_minutes)
   VALUES (@user_id, @started_at, @work_date, @start_time, @description_enc, @jira_key, @carry_minutes)
   ON CONFLICT(user_id) DO UPDATE SET
     started_at = excluded.started_at, work_date = excluded.work_date,
     start_time = excluded.start_time, description_enc = excluded.description_enc,
     jira_key = excluded.jira_key, carry_minutes = excluded.carry_minutes`
);
const updateTimerStmt = db.prepare(
  'UPDATE active_timers SET description_enc = ?, jira_key = ? WHERE user_id = ?'
);
const deleteTimerStmt = db.prepare('DELETE FROM active_timers WHERE user_id = ?');
const insertEntryStmt = db.prepare(
  `INSERT INTO entries (user_id, work_date, start_time, end_time, duration_minutes, description_enc, jira_key)
   VALUES (@user_id, @work_date, @start_time, @end_time, @duration_minutes, @description_enc, @jira_key)`
);
const getEntryStmt = db.prepare('SELECT * FROM entries WHERE id = ?');
const getOwnEntryStmt = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
const trashEntryStmt = db.prepare("UPDATE entries SET deleted_at = datetime('now') WHERE id = ? AND user_id = ?");

function fromMinutes(total) {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function cleanJira(value) {
  const key = value ? convertTicketLinks(String(value).trim()).slice(0, 40) : '';
  return key === '' ? null : key;
}

function cleanDescription(value) {
  const text = value ? String(value).trim().slice(0, 2000) : '';
  return text === '' ? null : text;
}

function serializeTimer(row) {
  if (!row) return null;
  return {
    startedAt: row.started_at,
    workDate: row.work_date,
    startTime: row.start_time,
    description: row.description_enc ? decryptField(row.description_enc) : '',
    jiraKey: row.jira_key,
    carryMinutes: row.carry_minutes || 0,
  };
}

/** Aktuell laufenden Timer abfragen (null, wenn keiner laeuft). */
router.get('/', (req, res) => {
  res.json({ timer: serializeTimer(getTimerStmt.get(req.user.id)) });
});

/**
 * Timer starten. Datum und Startzeit kommen vom Client, weil nur dort die
 * lokale Zeitzone der Person bekannt ist; started_at dient der Anzeige der
 * verstrichenen Zeit und ist vom Server (nicht manipulierbar relevant).
 */
router.post('/', (req, res) => {
  const { work_date, start_time } = req.body || {};
  if (!DATE_RE.test(work_date || '')) return res.status(400).json({ error: 'Ungueltiges Datum.' });
  if (!TIME_RE.test(start_time || '')) return res.status(400).json({ error: 'Ungueltige Startzeit (HH:MM).' });

  if (getTimerStmt.get(req.user.id)) {
    return res.status(409).json({ error: 'Es laeuft bereits ein Timer.' });
  }

  const description = cleanDescription(req.body.description);

  // Weitermachen nach einer Unterbrechung: Der fruehere Teil (ein eigener Eintrag) wird
  // geloescht, seine Zeit zaehlt zum neuen Eintrag. Nur, wenn das ohne Folgen geht.
  let carry = 0;
  let resumeEntry = null;
  const resumeId = req.body.resume_entry_id;
  if (resumeId !== undefined && resumeId !== null) {
    const reject = (error) => res.status(409).json({ error, mergeRejected: true });
    resumeEntry = Number.isInteger(resumeId) ? getOwnEntryStmt.get(resumeId, req.user.id) : null;
    if (!resumeEntry) return reject('Der fruehere Teil existiert nicht mehr.');
    if (resumeEntry.transferred_to_jira) return reject('Der fruehere Teil ist schon in Jira eingetragen.');
    if (resumeEntry.work_date !== work_date) return reject('Der fruehere Teil stammt von einem anderen Tag.');
    carry = parseInt(req.body.carry_minutes, 10);
    if (!Number.isInteger(carry) || carry < 0 || carry > resumeEntry.duration_minutes) {
      return reject('Ungueltige uebernommene Zeit.');
    }
  }

  const start = db.transaction(() => {
    if (resumeEntry) trashEntryStmt.run(resumeEntry.id, req.user.id);
    startTimerStmt.run({
      user_id: req.user.id,
      started_at: new Date().toISOString(),
      work_date,
      start_time,
      description_enc: description ? encryptField(description) : null,
      jira_key: cleanJira(req.body.jira_key),
      carry_minutes: carry,
    });
  });
  start();
  res.status(201).json({ timer: serializeTimer(getTimerStmt.get(req.user.id)), mergedEntryId: resumeEntry ? resumeEntry.id : null });
});

/** Beschreibung/Ticket waehrend der laufenden Zeit nachtragen. */
router.patch('/', (req, res) => {
  if (!getTimerStmt.get(req.user.id)) {
    return res.status(404).json({ error: 'Es laeuft kein Timer.' });
  }
  const description = cleanDescription(req.body && req.body.description);
  updateTimerStmt.run(
    description ? encryptField(description) : null,
    cleanJira(req.body && req.body.jira_key),
    req.user.id
  );
  res.json({ timer: serializeTimer(getTimerStmt.get(req.user.id)) });
});

/**
 * Timer stoppen und daraus einen Zeiteintrag erzeugen. Die Endzeit kommt
 * vom Client (lokale Zeit). Der Eintrag laesst sich danach ganz normal
 * bearbeiten, um Zeiten nachzujustieren.
 */
router.post('/stop', (req, res) => {
  const timer = getTimerStmt.get(req.user.id);
  if (!timer) return res.status(404).json({ error: 'Es laeuft kein Timer.' });

  const { end_time } = req.body || {};
  if (!TIME_RE.test(end_time || '')) return res.status(400).json({ error: 'Ungueltige Endzeit (HH:MM).' });

  // Beim Stoppen mitgeschickter Text hat Vorrang, sonst der waehrend der
  // laufenden Zeit gespeicherte.
  const provided = cleanDescription(req.body.description);
  const stored = timer.description_enc ? decryptField(timer.description_enc) : null;
  const description = provided || stored || '';
  const jiraKey = req.body.jira_key !== undefined ? cleanJira(req.body.jira_key) : timer.jira_key;
  if (!description && !jiraKey) {
    return res.status(400).json({ error: 'Bitte zuerst eine Beschreibung oder ein Ticket eintragen.' });
  }

  let endTime = end_time;
  let duration = toMinutes(end_time) - toMinutes(timer.start_time);
  // Direkt wieder gestoppt (gleiche Minute): als Eintrag von einer Minute festhalten,
  // statt mit einer Fehlermeldung abzulehnen.
  if (duration === 0 && toMinutes(timer.start_time) < 23 * 60 + 59) {
    duration = 1;
    endTime = fromMinutes(toMinutes(timer.start_time) + 1);
  }
  if (duration <= 0) {
    return res.status(400).json({
      error:
        'Die Endzeit liegt nicht nach der Startzeit (z.B. bei einem Timer ueber Mitternacht). ' +
        'Bitte den Timer verwerfen und den Eintrag von Hand erfassen.',
    });
  }

  // Uebernommene Zeit eines frueheren Teils: der Eintrag beginnt entsprechend frueher
  // (liegt also nie vor dem Start des fruehen Teils); reicht der Tag dafuer nicht, wird
  // das Ende nach hinten geschoben.
  let startMin = toMinutes(timer.start_time);
  let endMin = toMinutes(endTime);
  const carry = timer.carry_minutes || 0;
  if (carry > 0) {
    startMin -= carry;
    if (startMin < 0) {
      endMin -= startMin;
      startMin = 0;
    }
    duration += carry;
    if (endMin > 23 * 60 + 59) {
      return res.status(400).json({ error: 'Mit der uebernommenen Zeit reicht der Tag nicht. Bitte verwerfen und von Hand erfassen.' });
    }
  }
  if (duration > 16 * 60) {
    return res.status(400).json({
      error: 'Der Timer laeuft laenger als 16 Stunden. Bitte verwerfen und von Hand erfassen.',
    });
  }

  const stop = db.transaction(() => {
    const info = insertEntryStmt.run({
      user_id: req.user.id,
      work_date: timer.work_date,
      start_time: fromMinutes(startMin),
      end_time: fromMinutes(endMin),
      duration_minutes: duration,
      description_enc: encryptField(description),
      jira_key: jiraKey,
    });
    deleteTimerStmt.run(req.user.id);
    return info.lastInsertRowid;
  });
  const entryId = stop();

  const row = getEntryStmt.get(entryId);
  res.status(201).json({
    entry: {
      id: row.id,
      workDate: row.work_date,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMinutes: row.duration_minutes,
      description,
      jiraKey: row.jira_key,
      transferred: false,
    },
  });
});

/** Timer verwerfen, ohne einen Eintrag anzulegen. */
router.delete('/', (req, res) => {
  deleteTimerStmt.run(req.user.id);
  res.json({ status: 'ok' });
});

module.exports = router;
