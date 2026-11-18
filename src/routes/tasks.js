'use strict';

// Aufgabenliste: anlegen, ändern, abhaken (mit Wiederholung), Papierkorb (kurz rückgängig), "Später erinnern".
// Abhaken passiert nie automatisch (auch nicht beim Stoppen eines Timers), nur durch den Nutzer.

const express = require('express');
const { normalizeRepeat, nextDue } = require('../lib/taskRepeat');
const { isValidDate, todayLocal } = require('../lib/dates');
const { localStamp } = require('../lib/taskReminders');

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_TITLE = 500;

function createRouter({ db, encryptField, decryptField, convertTicketLinks, now = () => new Date() }) {
  const router = express.Router();

  const getOwn = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
  const insert = db.prepare(
    `INSERT INTO tasks (user_id, title_enc, jira_key, due_date, due_time, priority, repeat_json)
     VALUES (@user_id, @title_enc, @jira_key, @due_date, @due_time, @priority, @repeat_json)`
  );
  const update = db.prepare(
    `UPDATE tasks SET title_enc=@title_enc, jira_key=@jira_key, due_date=@due_date, due_time=@due_time,
       priority=@priority, repeat_json=@repeat_json, reminded_at=@reminded_at, snooze_until=NULL, updated_at=datetime('now')
     WHERE id=@id AND user_id=@user_id AND deleted_at IS NULL`
  );

  const serialize = (r) => ({
    id: r.id,
    title: decryptField(r.title_enc),
    jiraKey: r.jira_key,
    dueDate: r.due_date,
    dueTime: r.due_time,
    priority: r.priority,
    status: r.status,
    doneAt: r.done_at,
    repeat: r.repeat_json ? JSON.parse(r.repeat_json) : null,
    snoozeUntil: r.snooze_until,
    createdAt: r.created_at,
  });

  /** Eingabe prüfen; liefert { fields } oder { error }. partial: nur gelieferte Felder, sonst alle. */
  function parse(body, current) {
    const b = body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const out = {
      title: current ? decryptField(current.title_enc) : '',
      jira_key: current ? current.jira_key : null,
      due_date: current ? current.due_date : null,
      due_time: current ? current.due_time : null,
      priority: current ? current.priority : 0,
      repeat: current && current.repeat_json ? JSON.parse(current.repeat_json) : null,
    };
    if (has('title')) {
      out.title = String(b.title === null ? '' : b.title).trim();
      if (out.title.length > MAX_TITLE) return { error: `Titel ist zu lang (max. ${MAX_TITLE} Zeichen).` };
    }
    if (has('jira_key')) {
      let key = b.jira_key ? convertTicketLinks(String(b.jira_key).trim()).slice(0, 40) : null;
      if (key === '') key = null;
      out.jira_key = key;
    }
    if (has('due_date')) {
      if (b.due_date === null || b.due_date === '') { out.due_date = null; out.due_time = null; } else {
        if (!isValidDate(b.due_date)) return { error: 'Ungültiges Datum.' };
        out.due_date = b.due_date;
      }
    }
    if (has('due_time')) {
      if (b.due_time === null || b.due_time === '') out.due_time = null;
      else if (!TIME_RE.test(b.due_time)) return { error: 'Ungültige Uhrzeit (HH:MM).' };
      else out.due_time = b.due_time;
    }
    if (out.due_time && !out.due_date) return { error: 'Eine Uhrzeit braucht ein Datum.' };
    if (has('priority')) {
      const p = Number(b.priority);
      if (![0, 1].includes(p)) return { error: 'Ungültige Priorität.' };
      out.priority = p;
    }
    if (has('repeat')) {
      try { out.repeat = normalizeRepeat(b.repeat); } catch (err) { return { error: err.message }; }
    }
    if (out.repeat && !out.due_date) return { error: 'Eine Wiederholung braucht ein Fälligkeitsdatum.' };
    if (!out.title && !out.jira_key) return { error: 'Bitte einen Titel oder ein Ticket angeben.' };
    return { fields: out };
  }

  function toRow(fields, extra) {
    return {
      title_enc: encryptField(fields.title),
      jira_key: fields.jira_key,
      due_date: fields.due_date,
      due_time: fields.due_time,
      priority: fields.priority,
      repeat_json: fields.repeat ? JSON.stringify(fields.repeat) : null,
      ...extra,
    };
  }

  // Liste: scope=open (Standard) | done (zuletzt erledigte) | all
  router.get('/', (req, res) => {
    const scope = ['open', 'done', 'all'].includes(req.query.scope) ? req.query.scope : 'open';
    let rows;
    if (scope === 'done') {
      rows = db.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'done' AND deleted_at IS NULL ORDER BY done_at DESC, id DESC LIMIT 100").all(req.user.id);
    } else if (scope === 'all') {
      rows = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 500').all(req.user.id);
    } else {
      rows = db.prepare(
        `SELECT * FROM tasks WHERE user_id = ? AND status = 'open' AND deleted_at IS NULL
         ORDER BY (due_date IS NULL), due_date ASC, COALESCE(due_time, '99:99') ASC, priority DESC, id ASC`
      ).all(req.user.id);
    }
    res.json({ tasks: rows.map(serialize), today: todayLocal(now()) });
  });

  router.post('/', (req, res) => {
    const parsed = parse(req.body, null);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const info = insert.run({ user_id: req.user.id, ...toRow(parsed.fields) });
    res.status(201).json({ task: serialize(getOwn.get(info.lastInsertRowid, req.user.id)) });
  });

  router.put('/:id', (req, res) => {
    const current = getOwn.get(req.params.id, req.user.id);
    if (!current) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
    const parsed = parse(req.body, current);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    // Neuer Termin = neue Erinnerung
    const moved = parsed.fields.due_date !== current.due_date || parsed.fields.due_time !== current.due_time;
    update.run({ id: current.id, user_id: req.user.id, ...toRow(parsed.fields), reminded_at: moved ? null : current.reminded_at });
    res.json({ task: serialize(getOwn.get(current.id, req.user.id)) });
  });

  // Abhaken / wieder öffnen. Bei einer Wiederholung entsteht beim Abhaken die nächste Aufgabe.
  router.patch('/:id/done', (req, res) => {
    const current = getOwn.get(req.params.id, req.user.id);
    if (!current) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
    const done = req.body && req.body.done === false ? false : true;
    if (!done) {
      db.prepare("UPDATE tasks SET status='open', done_at=NULL, updated_at=datetime('now') WHERE id=?").run(current.id);
      return res.json({ task: serialize(getOwn.get(current.id, req.user.id)), next: null });
    }
    if (current.status === 'done') return res.json({ task: serialize(current), next: null });
    const stamp = localStamp(now());
    let next = null;
    db.transaction(() => {
      db.prepare("UPDATE tasks SET status='done', done_at=?, snooze_until=NULL, updated_at=datetime('now') WHERE id=?").run(stamp, current.id);
      const repeat = current.repeat_json ? JSON.parse(current.repeat_json) : null;
      const due = repeat ? nextDue(current.due_date, repeat, todayLocal(now())) : null;
      if (due) {
        const info = insert.run({
          user_id: req.user.id,
          title_enc: current.title_enc,
          jira_key: current.jira_key,
          due_date: due,
          due_time: current.due_time,
          priority: current.priority,
          repeat_json: current.repeat_json,
        });
        next = getOwn.get(info.lastInsertRowid, req.user.id);
      }
    })();
    res.json({ task: serialize(getOwn.get(current.id, req.user.id)), next: next ? serialize(next) : null });
  });

  // Später erinnern: in N Minuten (5 bis 24 Stunden)
  router.post('/:id/snooze', (req, res) => {
    const current = getOwn.get(req.params.id, req.user.id);
    if (!current) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
    const minutes = Number(req.body && req.body.minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60) return res.status(400).json({ error: 'Bitte 5 bis 1440 Minuten angeben.' });
    const until = localStamp(new Date(now().getTime() + minutes * 60_000));
    db.prepare("UPDATE tasks SET snooze_until=?, updated_at=datetime('now') WHERE id=?").run(until, current.id);
    res.json({ task: serialize(getOwn.get(current.id, req.user.id)) });
  });

  router.delete('/:id', (req, res) => {
    const info = db.prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL").run(req.params.id, req.user.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
    res.json({ ok: true });
  });

  router.post('/:id/restore', (req, res) => {
    const info = db.prepare(
      `UPDATE tasks SET deleted_at = NULL WHERE id = ? AND user_id = ?
         AND deleted_at IS NOT NULL AND deleted_at > datetime('now', '-120 seconds')`
    ).run(req.params.id, req.user.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Aufgabe kann nicht mehr wiederhergestellt werden.' });
    res.json({ task: serialize(getOwn.get(req.params.id, req.user.id)) });
  });

  return router;
}

module.exports = { createRouter };
