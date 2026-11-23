'use strict';

// Einträge als interne Kommentare nach Jira schreiben: "45 Min – Netzwerkdoku ergänzt" ins Ticket des Eintrags,
// sonst ins Ticket seiner Aufgabe, Arbeiten ganz ohne Ticket ins Tagesticket (Projekt aus den Jira-Einstellungen,
// Titel = Datum, z. B. "2026-11-20"). plan() zeigt vorher, was wohin geht, ohne etwas zu schreiben.
// Ein Kommentar je Eintrag; seine ID steht am Eintrag, damit spätere Änderungen und das Löschen mitgehen.

const jira = require('./jira');

function createJiraComments({ db, decryptField, fetchImpl }) {
  const getEntry = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL');
  const setComment = db.prepare(
    "UPDATE entries SET jira_comment_issue = ?, jira_comment_id = ?, transferred_to_jira = 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
  );
  const taskTicket = db.prepare('SELECT jira_key, title_enc FROM tasks WHERE id = ? AND user_id = ?');
  const clearComment = db.prepare('UPDATE entries SET jira_comment_issue = NULL, jira_comment_id = NULL, transferred_to_jira = 0 WHERE id = ? AND user_id = ?');

  const config = (userId) => jira.loadConfig(db, decryptField, userId);

  /** Jira-Zugang zum Schreiben, sonst ein verständlicher Fehler. */
  function writer(userId) {
    const c = config(userId);
    if (!c || !c.token) throw new jira.JiraError('Jira ist noch nicht eingerichtet (Einstellungen → Jira).', 409);
    if (!c.allowWrite) throw new jira.JiraError('Das Schreiben nach Jira ist ausgeschaltet (Einstellungen → Jira).', 409);
    return { client: jira.createClient({ baseUrl: c.baseUrl, email: c.email, token: c.token, fetchImpl }), dailyProject: c.dailyProject || '' };
  }

  /** "45 Min – Netzwerkdoku ergänzt" (mit Uhrzeiten: "08:05–08:50 (45 Min) – …"); ohne Text nur die Zeit. */
  function commentText(entry, withTimes) {
    const text = decryptField(entry.description_enc) || '';
    const time = withTimes ? `${entry.start_time}–${entry.end_time} (${entry.duration_minutes} Min)` : `${entry.duration_minutes} Min`;
    return text ? `${time} – ${text}` : time;
  }

  const validKey = (k) => { const v = String(k || '').trim().toUpperCase(); return jira.KEY_RE.test(v) ? v : ''; };

  /**
   * Ticket für einen Eintrag: sein eigenes, sonst das Ticket seiner Aufgabe, sonst das Tagesticket (pro Datum gemerkt).
   * Ergebnis {key, source: 'eintrag'|'aufgabe'|'tagesticket', taskTitle?}.
   */
  async function target(w, entry, cache, userId) {
    const own = validKey(entry.jira_key);
    if (own) return { key: own, source: 'eintrag' };
    if (entry.task_id) {
      const t = taskTicket.get(entry.task_id, userId);
      const k = t && validKey(t.jira_key);
      if (k) return { key: k, source: 'aufgabe', taskTitle: decryptField(t.title_enc) };
    }
    if (!w.dailyProject) throw new jira.JiraError('Eintrag ohne Ticket und kein Projekt für Tagestickets eingestellt (Einstellungen → Jira).', 400);
    if (!cache.has(entry.work_date)) cache.set(entry.work_date, await w.client.dailyIssue(w.dailyProject, entry.work_date));
    const key = cache.get(entry.work_date);
    if (!key) throw new jira.JiraError(`Kein Tagesticket „${entry.work_date}“ im Projekt ${w.dailyProject} gefunden.`, 404);
    return { key, source: 'tagesticket' };
  }

  /**
   * Vorschau: wohin welcher Eintrag geht und mit welchem Text, ohne etwas zu schreiben. Je Eintrag
   * {id, key, source, summary, text, action: 'neu'|'aktualisieren'|'verschieben', from?} oder {id, error}.
   */
  async function plan(userId, ids, { withTimes = false } = {}) {
    const w = writer(userId);
    const cache = new Map();
    const items = [];
    for (const id of ids) {
      const entry = getEntry.get(id, userId);
      if (!entry) { items.push({ id, error: 'Eintrag nicht gefunden.' }); continue; }
      try {
        const t = await target(w, entry, cache, userId);
        const action = !entry.jira_comment_id ? 'neu' : entry.jira_comment_issue === t.key ? 'aktualisieren' : 'verschieben';
        items.push({ id, ...t, workDate: entry.work_date, text: commentText(entry, withTimes), action, ...(action === 'verschieben' ? { from: entry.jira_comment_issue } : {}) });
      } catch (err) {
        items.push({ id, error: err instanceof jira.JiraError ? err.message : 'Unerwarteter Fehler.' });
      }
    }
    // Titel der Tickets dazu (eine Abfrage); fehlt einer, bleibt es bei der Nummer
    const keys = [...new Set(items.filter((i) => i.key).map((i) => i.key))];
    if (keys.length) {
      try {
        const info = await w.client.statuses(keys);
        for (const i of items) if (i.key && info.has(i.key)) i.summary = info.get(i.key).summary;
      } catch { /* ohne Titel */ }
    }
    return items;
  }

  /**
   * Einträge schreiben (neu oder aktualisieren). Ergebnis je Eintrag: {id, ok, key} oder {id, ok:false, error}.
   * Fehler bei einem Eintrag halten die anderen nicht auf.
   */
  async function post(userId, ids, { withTimes = false } = {}) {
    const w = writer(userId);
    const cache = new Map();
    const results = [];
    for (const id of ids) {
      const entry = getEntry.get(id, userId);
      if (!entry) { results.push({ id, ok: false, error: 'Eintrag nicht gefunden.' }); continue; }
      try {
        const { key, source } = await target(w, entry, cache, userId);
        const text = commentText(entry, withTimes);
        let commentId = entry.jira_comment_id;
        let updated = false;
        let gone = false;
        if (commentId && entry.jira_comment_issue === key) {
          try {
            await w.client.updateComment(key, commentId, text);
            updated = true;
          } catch (err) {
            if (err.status !== 404) throw err;
            gone = true; // in Jira gelöscht: neu anlegen
          }
        }
        if (!updated) {
          // Ticket gewechselt: alten Kommentar entfernen (Fehler dabei halten das Schreiben nicht auf)
          if (commentId && entry.jira_comment_issue && !gone) await w.client.deleteComment(entry.jira_comment_issue, commentId).catch(() => {});
          commentId = await w.client.addComment(key, text);
        }
        setComment.run(key, commentId, entry.id, userId);
        results.push({ id, ok: true, key, source, daily: source === 'tagesticket' });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof jira.JiraError ? err.message : 'Unerwarteter Fehler.' });
      }
    }
    return results;
  }

  /**
   * Nach dem Bearbeiten eines Eintrags: hat er schon einen Kommentar, wird dieser angepasst (bzw. ins neue Ticket
   * verschoben). Gibt null zurück, wenn nichts zu tun war, sonst {ok, error?}.
   */
  async function afterEdit(userId, entryId, { withTimes = false } = {}) {
    const entry = getEntry.get(entryId, userId);
    if (!entry || !entry.jira_comment_id) return null;
    try {
      const [r] = await post(userId, [entryId], { withTimes });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Vor dem Löschen eines Eintrags: seinen Kommentar in Jira entfernen. */
  async function beforeDelete(userId, entry) {
    if (!entry || !entry.jira_comment_id) return null;
    try {
      const w = writer(userId);
      await w.client.deleteComment(entry.jira_comment_issue, entry.jira_comment_id);
      clearComment.run(entry.id, userId);
      return { ok: true };
    } catch (err) {
      if (err.status === 404) { clearComment.run(entry.id, userId); return { ok: true }; } // schon weg
      return { ok: false, error: err.message };
    }
  }

  return { post, plan, afterEdit, beforeDelete, commentText };
}

module.exports = { createJiraComments };
