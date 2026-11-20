'use strict';

// Jira-Abgleich für Aufgaben:
// - Offene Aufgaben mit Ticket: ist das Ticket in Jira erledigt (Statuskategorie "Fertig"), bekommt die Aufgabe den
//   Hinweis "in Jira erledigt – abhaken?" (jira_done_hint = 'new'). Abgehakt wird nie automatisch. "Nicht abhaken"
//   setzt 'dismissed'; wird das Ticket wieder geöffnet, verschwindet der Hinweis.
// - Neue Tickets für mich: was neu unter "mir zugewiesen, nicht erledigt" auftaucht und noch keine Aufgabe ist.
//   Der erste Abgleich merkt sich nur den Stand (keine Flut beim Einschalten).
// Läuft im Hintergrund (lokal, mit Benachrichtigung) und beim Öffnen der Aufgaben-Seite; höchstens alle 5 Minuten.

const jira = require('./jira');

const MIN_INTERVAL_MS = 5 * 60_000;

function createJiraSync({ db, decryptField, fetchImpl, minIntervalMs = MIN_INTERVAL_MS }) {
  const openTasks = db.prepare(
    `SELECT id, title_enc, jira_key, jira_status, jira_done_hint FROM tasks
     WHERE user_id = ? AND status = 'open' AND deleted_at IS NULL AND jira_key IS NOT NULL AND jira_key <> ''`
  );
  const taskKeys = db.prepare("SELECT DISTINCT upper(jira_key) AS k FROM tasks WHERE user_id = ? AND deleted_at IS NULL AND jira_key IS NOT NULL");
  const setTask = db.prepare('UPDATE tasks SET jira_status = ?, jira_done_hint = ? WHERE id = ?');
  const seen = db.prepare('SELECT 1 FROM jira_seen WHERE user_id = ? AND key = ?');
  const addSeen = db.prepare('INSERT OR IGNORE INTO jira_seen (user_id, key) VALUES (?, ?)');
  const configuredUsers = db.prepare('SELECT user_id FROM jira_settings');
  const lastRun = new Map();

  /** Einstellungen des Abgleichs (beide standardmäßig an). */
  const options = (c) => ({ syncTasks: c.syncTasks !== false, notifyNew: c.notifyNew !== false });

  /**
   * Abgleich für eine Person. Ergebnis: null (Jira nicht eingerichtet), {skipped:true} (gerade erst gelaufen) oder
   * {doneTasks:[{id,title,key,status}], newIssues:[{key,summary}]} – nur, was seit dem letzten Mal neu ist.
   */
  async function run(userId, { force = false, now = Date.now() } = {}) {
    const c = jira.loadConfig(db, decryptField, userId);
    if (!c || !c.token) return null;
    const opt = options(c);
    if (!opt.syncTasks && !opt.notifyNew) return { doneTasks: [], newIssues: [] };
    if (!force && lastRun.has(userId) && now - lastRun.get(userId) < minIntervalMs) return { skipped: true };
    lastRun.set(userId, now);
    const client = jira.createClient({ baseUrl: c.baseUrl, email: c.email, token: c.token, fetchImpl });
    const result = { doneTasks: [], newIssues: [] };

    if (opt.syncTasks) {
      const tasks = openTasks.all(userId);
      const info = await client.statuses(tasks.map((t) => t.jira_key));
      for (const t of tasks) {
        const key = t.jira_key.trim().toUpperCase();
        const issue = info.get(key);
        if (!issue) continue;
        let hint = t.jira_done_hint;
        if (issue.done && !hint) {
          hint = 'new';
          result.doneTasks.push({ id: t.id, title: decryptField(t.title_enc), key, status: issue.status });
        } else if (!issue.done) {
          hint = null;
        }
        if (hint !== t.jira_done_hint || issue.status !== t.jira_status) setTask.run(issue.status, hint, t.id);
      }
    }

    if (opt.notifyNew) {
      const issues = await client.myIssues({ max: 100 });
      const first = !seen.get(userId, '*');
      const have = new Set(taskKeys.all(userId).map((r) => r.k));
      for (const i of issues) {
        if (seen.get(userId, i.key)) continue;
        addSeen.run(userId, i.key);
        if (!first && !have.has(i.key)) result.newIssues.push({ key: i.key, summary: i.summary });
      }
      addSeen.run(userId, '*');
    }
    return result;
  }

  /** Benachrichtigungen zu einem Ergebnis (Titel, Text). */
  function messages(r) {
    const out = [];
    if (!r || r.skipped) return out;
    const label = (t) => `${t.key}${t.title ? ` „${t.title}“` : ''}`;
    if (r.doneTasks.length === 1) out.push({ title: 'Ticket in Jira erledigt', body: `${label(r.doneTasks[0])} – Aufgabe abhaken?` });
    else if (r.doneTasks.length > 1) out.push({ title: `${r.doneTasks.length} Tickets in Jira erledigt`, body: `${r.doneTasks.slice(0, 4).map(label).join('\n')}\nAufgaben abhaken? (Seite „Aufgaben“)` });
    if (r.newIssues.length === 1) out.push({ title: 'Neues Jira-Ticket für dich', body: `${r.newIssues[0].key} ${r.newIssues[0].summary}` });
    else if (r.newIssues.length > 1) out.push({ title: `${r.newIssues.length} neue Jira-Tickets für dich`, body: r.newIssues.slice(0, 4).map((i) => `${i.key} ${i.summary}`).join('\n') });
    return out;
  }

  /** Alle eingerichteten Personen abgleichen (Hintergrund); Fehler einzelner Personen halten die anderen nicht auf. */
  async function runAll({ notify = () => {}, log = () => {} } = {}) {
    for (const { user_id: userId } of configuredUsers.all()) {
      try {
        for (const m of messages(await run(userId))) notify(m);
      } catch (err) {
        log(`Jira-Abgleich: ${err.message}`);
      }
    }
  }

  return { run, runAll, messages };
}

/** Hintergrund-Abgleich alle 15 Minuten (erster Lauf nach einer Minute). Gibt eine Funktion zum Beenden zurück. */
function startJiraSyncLoop({ sync, notify, log = () => {}, intervalMs = 15 * 60_000, firstDelayMs = 60_000 }) {
  const tick = () => { sync.runAll({ notify, log }).catch((err) => log(`Jira-Abgleich: ${err.message}`)); };
  const first = setTimeout(tick, firstDelayMs);
  const timer = setInterval(tick, intervalMs);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

module.exports = { createJiraSync, startJiraSyncLoop, MIN_INTERVAL_MS };
