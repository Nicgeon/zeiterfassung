'use strict';

// Tagestickets abschließen (nur nach Bestätigung): Stehen alle Einträge eines Tages in Jira und ist Feierabend (bzw.
// der Tag vorbei), schlägt das Programm vor, das Tagesticket dieses Tages (Projekt aus Einstellungen → Jira, Titel =
// Datum) auf "Fertig" zu setzen. Gefragt wird auf der Seite "Heute"; im Hintergrund kommt dazu einmal eine
// Benachrichtigung, die nur zur Bestätigung ins Programm schickt. Ohne Klick ändert sich in Jira nichts.

const jira = require('./jira');

const LOOKBACK_DAYS = 14; // ältere Tage werden nicht mehr vorgeschlagen

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localHM = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function createJiraDaily({ db, decryptField, fetchImpl, endTimeFor = () => '16:30' }) {
  const days = db.prepare(
    `SELECT work_date,
            SUM(CASE WHEN transferred_to_jira = 0 AND school_day = 0 THEN 1 ELSE 0 END) AS open,
            COUNT(*) AS n,
            SUM(duration_minutes) AS minutes,
            MAX(CASE WHEN jira_comment_issue LIKE @prefix THEN jira_comment_issue END) AS daily_key
     FROM entries
     WHERE user_id = @user AND deleted_at IS NULL AND work_date >= @since AND work_date <= @today
     GROUP BY work_date`
  );
  const getState = db.prepare('SELECT * FROM jira_daily_close WHERE user_id = ? AND work_date = ?');
  const setState = db.prepare(
    `INSERT INTO jira_daily_close (user_id, work_date, key, status) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, work_date) DO UPDATE SET key = excluded.key, status = excluded.status, updated_at = datetime('now')`
  );
  const configuredUsers = db.prepare('SELECT user_id FROM jira_settings');

  /** Einstellungen, wenn das Abschließen eingeschaltet ist und alles dafür da ist, sonst null. */
  function options(userId) {
    const c = jira.loadConfig(db, decryptField, userId);
    if (!c || !c.token || !c.allowWrite || !c.closeDaily || !c.dailyProject) return null;
    return c;
  }

  /**
   * Tage, deren Tagesticket abgeschlossen werden kann: Einträge stehen im Tagesticket, kein Eintrag des Tages ist mehr
   * offen (Berufsschule zählt nicht), Feierabend ist vorbei (heute) bzw. der Tag liegt zurück, und es wurde weder
   * abgeschlossen noch "Nicht abschließen" gewählt. [{date, key, count, minutes, notified}]
   */
  function pending(userId, now = new Date()) {
    const c = options(userId);
    if (!c) return [];
    const today = localDate(now);
    const since = new Date(now);
    since.setDate(since.getDate() - LOOKBACK_DAYS);
    const afterWork = localHM(now) >= endTimeFor(userId);
    const out = [];
    for (const d of days.all({ user: userId, prefix: `${c.dailyProject}-%`, since: localDate(since), today })) {
      if (!d.daily_key || d.open > 0) continue;
      if (d.work_date === today && !afterWork) continue;
      const st = getState.get(userId, d.work_date);
      if (st && (st.status === 'closed' || st.status === 'dismissed')) continue;
      out.push({ date: d.work_date, key: d.daily_key, count: d.n, minutes: d.minutes, notified: !!st });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Tagesticket eines Tages auf "Fertig" setzen (nach Bestätigung). Ergebnis {key, status, already}. */
  async function close(userId, date) {
    const c = options(userId);
    if (!c) throw new jira.JiraError('Das Abschließen von Tagestickets ist ausgeschaltet (Einstellungen → Jira).', 409);
    const item = pending(userId, new Date(`${date}T23:59:00`)).find((p) => p.date === date)
      || pending(userId).find((p) => p.date === date);
    if (!item) throw new jira.JiraError('Für diesen Tag gibt es kein Tagesticket zum Abschließen (oder es sind noch Einträge offen).', 409);
    const client = jira.createClient({ baseUrl: c.baseUrl, email: c.email, token: c.token, fetchImpl });
    const r = await client.closeIssue(item.key);
    setState.run(userId, date, item.key, 'closed');
    return r;
  }

  /** "Nicht abschließen": für diesen Tag nicht mehr fragen. */
  function dismiss(userId, date) {
    const item = pending(userId, new Date(`${date}T23:59:00`)).find((p) => p.date === date);
    if (item) setState.run(userId, date, item.key, 'dismissed');
    return !!item;
  }

  /** Hintergrund: je neu abschließbarem Tag einmal eine Benachrichtigung (bestätigt wird im Programm). */
  function notifyAll({ notify = () => {}, log = () => {}, now = new Date() } = {}) {
    for (const { user_id: userId } of configuredUsers.all()) {
      try {
        const fresh = pending(userId, now).filter((p) => !p.notified);
        for (const p of fresh) setState.run(userId, p.date, p.key, 'notified');
        if (fresh.length === 1) {
          notify({ title: `Tagesticket ${fresh[0].key} abschließen?`, body: `Alle Einträge vom ${fresh[0].date.slice(8, 10)}.${fresh[0].date.slice(5, 7)}. stehen in Jira. Bestätigen auf der Seite „Heute“.` });
        } else if (fresh.length > 1) {
          notify({ title: `${fresh.length} Tagestickets abschließen?`, body: `${fresh.map((p) => p.key).join(', ')} – bestätigen auf der Seite „Heute“.` });
        }
      } catch (err) {
        log(`Tagestickets: ${err.message}`);
      }
    }
  }

  return { pending, close, dismiss, notifyAll };
}

module.exports = { createJiraDaily, LOOKBACK_DAYS };
