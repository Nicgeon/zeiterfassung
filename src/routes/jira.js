'use strict';

// Jira-Anbindung (optional): Zugangsdaten pro Person verschlüsselt speichern, testen, Ticket-Titel und eigene offene
// Tickets holen, Einträge als Kommentare schreiben, Aufgaben abgleichen. Das API-Token wird nie ausgegeben.

const express = require('express');
const jira = require('../lib/jira');
const { createJiraComments } = require('../lib/jiraComments');
const { createJiraSync } = require('../lib/jiraSync');

function createRouter({ db, encryptField, decryptField, audit = () => {}, fetchImpl, sync = createJiraSync({ db, decryptField, fetchImpl }) }) {
  const router = express.Router();
  const putStmt = db.prepare(
    `INSERT INTO jira_settings (user_id, config_enc, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET config_enc = excluded.config_enc, updated_at = excluded.updated_at`
  );
  const delStmt = db.prepare('DELETE FROM jira_settings WHERE user_id = ?');

  const load = (userId) => jira.loadConfig(db, decryptField, userId);
  const describe = (c) => ({
    configured: !!(c && c.baseUrl && c.email && c.token),
    baseUrl: (c && c.baseUrl) || '',
    email: (c && c.email) || '',
    hasToken: !!(c && c.token),
    allowWrite: !!(c && c.allowWrite),
    dailyProject: (c && c.dailyProject) || '',
    syncTasks: !c || c.syncTasks !== false, // Abgleich: erledigte Tickets erkennen (Standard an)
    notifyNew: !c || c.notifyNew !== false, // neue Tickets für mich melden (Standard an)
  });
  const comments = createJiraComments({ db, decryptField, fetchImpl });
  const clientFor = (userId) => {
    const c = load(userId);
    if (!c || !c.token) throw new jira.JiraError('Jira ist noch nicht eingerichtet (Konto → Jira-Anbindung).', 409);
    return jira.createClient({ baseUrl: c.baseUrl, email: c.email, token: c.token, fetchImpl });
  };
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) {
      if (err instanceof jira.JiraError) // 401/403 von Jira nie 1:1 weitergeben: die Seite würde das für ihre eigene Anmeldung bzw. den CSRF-Schutz halten
      return res.status([401, 403].includes(err.status) ? 400 : err.status >= 500 ? 502 : err.status).json({ error: err.message });
      // eslint-disable-next-line no-console
      console.error('[jira]', err && err.message);
      res.status(500).json({ error: 'Unerwarteter Fehler bei der Jira-Anbindung.' });
    }
  };

  router.get('/settings', wrap((req, res) => res.json(describe(load(req.user.id)))));

  router.put('/settings', wrap((req, res) => {
    const body = req.body || {};
    const current = load(req.user.id) || {};
    const baseUrl = jira.normalizeBaseUrl(body.baseUrl);
    const email = String(body.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new jira.JiraError('Bitte die E-Mail-Adresse deines Atlassian-Kontos eintragen.', 400);
    let token = typeof body.apiToken === 'string' ? body.apiToken.trim() : '';
    if (!token) token = current.token || '';
    if (!token) throw new jira.JiraError('Bitte den API-Token eintragen.', 400);
    if (token.length > 400) throw new jira.JiraError('Der API-Token ist zu lang.', 400);
    // Schreiben (interne Kommentare) nur nach ausdrücklichem Einschalten; Tagestickets: Projektschlüssel, z. B. PITPM
    const allowWrite = body.allowWrite !== undefined ? body.allowWrite === true : !!current.allowWrite;
    let dailyProject = body.dailyProject !== undefined ? String(body.dailyProject || '').trim().toUpperCase() : current.dailyProject || '';
    if (dailyProject && !jira.PROJECT_RE.test(dailyProject)) throw new jira.JiraError('Ungültiger Projektschlüssel für Tagestickets (z. B. PITPM).', 400);
    const flag = (name) => (body[name] !== undefined ? body[name] === true : current[name] !== false);
    const next = { baseUrl, email, token, allowWrite, dailyProject, syncTasks: flag('syncTasks'), notifyNew: flag('notifyNew') };
    putStmt.run(req.user.id, encryptField(JSON.stringify(next)));
    audit(req.user.id, 'jira_settings_changed', `${baseUrl}${allowWrite ? ' (schreiben)' : ''}`, req.ip);
    res.json(describe(next));
  }));

  router.delete('/settings', wrap((req, res) => {
    delStmt.run(req.user.id);
    audit(req.user.id, 'jira_settings_changed', 'entfernt', req.ip);
    res.json(describe(null));
  }));

  router.post('/test', wrap(async (req, res) => {
    const me = await clientFor(req.user.id).myself();
    res.json({ ok: true, displayName: me.displayName });
  }));

  router.get('/issue/:key', wrap(async (req, res) => {
    res.json({ issue: await clientFor(req.user.id).issue(req.params.key) });
  }));

  // Einträge als interne Kommentare schreiben (neu oder aktualisieren)
  router.post('/comments', wrap(async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Number.isInteger).slice(0, 200) : [];
    if (!ids.length) throw new jira.JiraError('Keine Einträge angegeben.', 400);
    const results = await comments.post(req.user.id, ids, { withTimes: !!(req.body && req.body.with_times) });
    const okCount = results.filter((r) => r.ok).length;
    if (okCount) audit(req.user.id, 'jira_comments_written', `${okCount} Eintraege`, req.ip);
    res.json({ results });
  }));

  // Tagesticket zu einem Datum (zum Prüfen in den Einstellungen)
  router.get('/daily/:date', wrap(async (req, res) => {
    const c = load(req.user.id);
    if (!c || !c.dailyProject) throw new jira.JiraError('Kein Projekt für Tagestickets eingestellt.', 400);
    res.json({ key: await clientFor(req.user.id).dailyIssue(c.dailyProject, req.params.date) });
  }));

  // Abgleich mit den Aufgaben (beim Öffnen der Aufgaben-Seite; höchstens alle 5 Minuten, sonst {skipped:true})
  router.post('/sync', wrap(async (req, res) => {
    const r = await sync.run(req.user.id, { force: !!(req.body && req.body.force) });
    res.json(r || { configured: false });
  }));

  router.get('/my-issues', wrap(async (req, res) => {
    res.json({ issues: await clientFor(req.user.id).myIssues() });
  }));

  return router;
}

module.exports = { createRouter };
