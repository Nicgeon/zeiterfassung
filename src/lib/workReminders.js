'use strict';

// Erinnerungen gegen Vergessen (nur lokal, als Systembenachrichtigung):
// - Timer läuft lange: nach N Stunden nachfragen, danach im selben Abstand erneut.
// - Lange nichts erfasst: in der Arbeitszeit (Mo–Fr), ohne laufenden Timer und erst nach dem ersten Eintrag des Tages.
//   Einmal je Lücke.
// - Feierabend: zur eingestellten Uhrzeit, wenn heute noch Einträge nicht in Jira sind oder der Timer läuft. Einmal am Tag.
// Jede Meldung wird in reminder_log vermerkt (kind + ref), damit sie auch nach einem Neustart nicht doppelt kommt.
// Die Auswahl ist reine Datenbanklogik (testbar mit festem "now"), das Anzeigen übernimmt der Aufrufer.

const DEFAULTS = Object.freeze({
  tasks: true, // fällige Aufgaben (taskReminders.js)
  timerLong: true,
  timerHours: 3,
  idle: true,
  idleMinutes: 45,
  workFrom: '07:00',
  workTo: '17:00',
  endOfDay: true,
  endTime: '16:30',
});

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const pad = (n) => String(n).padStart(2, '0');
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const hm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localHM = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const duration = (min) => (min >= 60 ? `${Math.floor(min / 60)}:${pad(min % 60)} Std.` : `${min} Min.`);
/** SQLite-Zeitstempel (UTC, "JJJJ-MM-TT HH:MM:SS") als Date. */
const fromSqlUtc = (s) => new Date(`${String(s).replace(' ', 'T')}Z`);

/** Eingaben prüfen und mit den Standardwerten auffüllen; ungültige Werte fallen auf den Standard zurück. */
function normalize(input = {}) {
  const out = { ...DEFAULTS };
  for (const key of ['tasks', 'timerLong', 'idle', 'endOfDay']) if (typeof input[key] === 'boolean') out[key] = input[key];
  const int = (v, min, max) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null);
  out.timerHours = int(input.timerHours, 1, 12) ?? DEFAULTS.timerHours;
  out.idleMinutes = int(input.idleMinutes, 15, 240) ?? DEFAULTS.idleMinutes;
  for (const key of ['workFrom', 'workTo', 'endTime']) if (HM_RE.test(input[key] || '')) out[key] = input[key];
  if (out.workFrom >= out.workTo) { out.workFrom = DEFAULTS.workFrom; out.workTo = DEFAULTS.workTo; }
  return out;
}

function createWorkReminders({ db, decryptField }) {
  const getSettings = db.prepare('SELECT config_json FROM reminder_settings WHERE user_id = ?');
  const putSettings = db.prepare(
    `INSERT INTO reminder_settings (user_id, config_json) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET config_json = excluded.config_json, updated_at = datetime('now')`
  );
  const users = db.prepare('SELECT id FROM users WHERE active = 1');
  const timerOf = db.prepare('SELECT * FROM active_timers WHERE user_id = ?');
  const entriesOf = db.prepare('SELECT * FROM entries WHERE user_id = ? AND work_date = ? AND deleted_at IS NULL');
  const taskTitle = db.prepare('SELECT title_enc FROM tasks WHERE id = ? AND user_id = ?');
  const wasSent = db.prepare('SELECT 1 FROM reminder_log WHERE user_id = ? AND kind = ? AND ref = ?');
  const markSent = db.prepare('INSERT OR IGNORE INTO reminder_log (user_id, kind, ref) VALUES (?, ?, ?)');

  function settings(userId) {
    const row = getSettings.get(userId);
    if (!row) return { ...DEFAULTS };
    try { return normalize(JSON.parse(row.config_json)); } catch { return { ...DEFAULTS }; }
  }
  function save(userId, input) {
    const cfg = normalize({ ...settings(userId), ...input });
    putSettings.run(userId, JSON.stringify(cfg));
    return cfg;
  }

  /** Meldung nur, wenn sie für (kind, ref) noch nicht kam; vermerkt sie dabei. */
  function once(userId, kind, ref, msg, out) {
    if (wasSent.get(userId, kind, ref)) return;
    markSent.run(userId, kind, ref);
    out.push({ user_id: userId, kind, ...msg });
  }

  function timerLabel(userId, timer) {
    const text = timer.description_enc ? decryptField(timer.description_enc) : '';
    if (text) return text;
    if (timer.task_id) {
      const t = taskTitle.get(timer.task_id, userId);
      if (t) return decryptField(t.title_enc);
    }
    return timer.jira_key || '';
  }

  /** Spätester Zeitpunkt (Minuten des Tages), zu dem heute etwas erfasst wurde: Ende echter Zeiträume, Anlegen, Ändern. */
  function lastActivity(list, today) {
    let last = -1;
    for (const e of list) {
      if (e.segments_json) {
        try { for (const [, end] of JSON.parse(e.segments_json)) last = Math.max(last, toMin(end)); } catch { /* egal */ }
      }
      for (const stamp of [e.created_at, e.updated_at]) {
        if (!stamp) continue;
        const d = fromSqlUtc(stamp);
        if (!Number.isNaN(d.getTime()) && localDate(d) === today) last = Math.max(last, d.getHours() * 60 + d.getMinutes());
      }
    }
    return last;
  }

  /** Fällige Meldungen aller Personen (und als gemeldet vermerkt): [{user_id, kind, title, body}]. */
  function take(now = new Date()) {
    const out = [];
    const today = localDate(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const weekday = (now.getDay() + 6) % 7 < 5;
    for (const { id: userId } of users.all()) {
      const cfg = settings(userId);
      const timer = timerOf.get(userId);
      const list = entriesOf.all(userId, today);

      // Timer läuft lange (gezählt ab dem echten Start dieses Laufs)
      if (cfg.timerLong && timer) {
        const started = new Date(timer.started_at);
        const minutes = Math.floor((now - started) / 60000);
        const step = cfg.timerHours * 60;
        const n = Math.floor(minutes / step);
        if (n >= 1) {
          const label = timerLabel(userId, timer);
          once(userId, 'timer', `${timer.started_at}#${n}`, {
            title: `Timer läuft seit ${duration(minutes)}`,
            body: `${label ? `„${label}“ – ` : ''}noch dran? Sonst stoppen und die Endzeit anpassen.`,
          }, out);
        }
      }

      // Lange nichts erfasst
      if (cfg.idle && !timer && weekday && list.length && nowMin >= toMin(cfg.workFrom) && nowMin < toMin(cfg.workTo)) {
        const last = lastActivity(list, today);
        if (last >= 0 && last <= nowMin && nowMin - last >= cfg.idleMinutes) {
          once(userId, 'idle', `${today} ${hm(last)}`, {
            title: `Seit ${duration(nowMin - last)} nichts erfasst`,
            body: `Zuletzt um ${hm(last)} Uhr. Timer starten oder die Zeit nachtragen?`,
          }, out);
        }
      }

      // Feierabend: offene Einträge (ohne Berufsschule) oder laufender Timer
      if (cfg.endOfDay && nowMin >= toMin(cfg.endTime)) {
        const open = list.filter((e) => !e.transferred_to_jira && !e.school_day);
        const running = timer && timer.work_date === today;
        if (open.length || running) {
          const minutes = open.reduce((n, e) => n + e.duration_minutes, 0);
          const parts = [];
          if (open.length) parts.push(`${open.length} ${open.length === 1 ? 'Eintrag' : 'Einträge'} (${duration(minutes)}) noch nicht in Jira.`);
          if (running) parts.push('Der Timer läuft noch.');
          once(userId, 'end', today, {
            title: open.length ? 'Feierabend? Noch nicht alles in Jira' : 'Feierabend? Der Timer läuft noch',
            body: parts.join(' '),
          }, out);
        }
      }
    }
    return out;
  }

  return { settings, save, take };
}

/** Prüft jede Minute und ruft notify({title, body}) je Meldung auf. Gibt eine Funktion zum Beenden zurück. */
function startWorkReminderLoop({ reminders, notify, intervalMs = 60_000, now = () => new Date(), log = () => {} }) {
  const tick = () => {
    try {
      for (const msg of reminders.take(now())) notify(msg);
    } catch (err) {
      log(`Erinnerungen: ${err.message}`);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { DEFAULTS, normalize, createWorkReminders, startWorkReminderLoop };
