'use strict';

// Erinnerungen an fällige Aufgaben. Eine Aufgabe mit Datum und Uhrzeit meldet sich zu dieser Zeit, eine nur mit
// Datum am Morgen dieses Tages (DEFAULT_TIME). Jede Fälligkeit wird nur einmal gemeldet (reminded_at); "Später
// erinnern" setzt snooze_until. Die Auswahl ist reine Datenbanklogik, das Anzeigen übernimmt der Aufrufer.

const DEFAULT_TIME = '09:00';

function pad(n) { return String(n).padStart(2, '0'); }

/** "JJJJ-MM-TT HH:MM" in lokaler Zeit. */
function localStamp(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function dueStamp(task) {
  return `${task.due_date} ${task.due_time || DEFAULT_TIME}`;
}

/**
 * Fällige, noch nicht gemeldete Aufgaben (aller Personen); markiert sie als gemeldet.
 * @returns {{id:number,user_id:number,title:string,jiraKey:string|null,due:string,overdueDays:number}[]}
 */
function takeDueReminders(db, decryptField, now = new Date()) {
  const stamp = localStamp(now);
  const rows = db.prepare(
    `SELECT * FROM tasks
     WHERE status = 'open' AND deleted_at IS NULL AND due_date IS NOT NULL
       AND (snooze_until IS NULL OR snooze_until <= @stamp)`
  ).all({ stamp });
  const mark = db.prepare('UPDATE tasks SET reminded_at = ?, snooze_until = NULL WHERE id = ?');
  const out = [];
  for (const t of rows) {
    const due = dueStamp(t);
    const snoozedFire = t.snooze_until && t.snooze_until <= stamp;
    if (due > stamp && !snoozedFire) continue; // noch nicht fällig
    if (!snoozedFire && t.reminded_at && t.reminded_at >= due) continue; // diese Fälligkeit schon gemeldet
    mark.run(stamp, t.id);
    out.push({
      id: t.id,
      user_id: t.user_id,
      title: decryptField(t.title_enc),
      jiraKey: t.jira_key,
      due,
      overdue: due < stamp,
    });
  }
  return out;
}

/** Sammelnachricht für mehrere Erinnerungen auf einmal (Titel, Text). */
function formatReminders(list) {
  if (list.length === 0) return null;
  const label = (r) => `${r.title || r.jiraKey || 'Aufgabe'}${r.title && r.jiraKey ? ` [${r.jiraKey}]` : ''}`;
  if (list.length === 1) return { title: list[0].overdue ? 'Aufgabe überfällig' : 'Aufgabe fällig', body: label(list[0]) };
  return { title: `${list.length} Aufgaben fällig`, body: list.slice(0, 4).map(label).join('\n') + (list.length > 4 ? `\n… und ${list.length - 4} weitere` : '') };
}

/**
 * Prüft regelmäßig auf fällige Aufgaben und ruft notify({title, body, tasks}) auf.
 * Gibt eine Funktion zum Beenden zurück.
 */
function startReminderLoop({ db, decryptField, notify, intervalMs = 30_000, now = () => new Date(), log = () => {} }) {
  const tick = () => {
    try {
      const list = takeDueReminders(db, decryptField, now());
      const msg = formatReminders(list);
      if (msg) notify({ ...msg, tasks: list });
    } catch (err) {
      log(`Erinnerungen: ${err.message}`);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { DEFAULT_TIME, localStamp, takeDueReminders, formatReminders, startReminderLoop };
