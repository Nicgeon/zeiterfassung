'use strict';

// Jira Cloud (lesend): Zugangsdaten prüfen, Ticket-Titel holen, eigene offene Tickets auflisten.
// Anmeldung mit E-Mail + API-Token (Basic). Es werden nur Adressen der Form https://<name>.atlassian.net akzeptiert
// (kein Zugriff auf beliebige Server). Das Token verlässt diese Datei nie in Meldungen oder Protokollen.

const BASE_RE = /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net$/i;
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const FIELDS = ['summary', 'status', 'priority', 'duedate'];
const MY_ISSUES_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

class JiraError extends Error {
  constructor(message, status = 502) { super(message); this.name = 'JiraError'; this.status = status; }
}

/** Adresse bereinigen (auch ein eingefügter Link wie https://firma.atlassian.net/browse/X-1 wird zur Basisadresse). */
function normalizeBaseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new JiraError('Bitte die Jira-Adresse eintragen (z. B. https://firma.atlassian.net).', 400);
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { url = null; }
  const origin = url ? url.origin.toLowerCase() : '';
  if (!BASE_RE.test(origin)) throw new JiraError('Die Adresse muss die Form https://firma.atlassian.net haben (Jira Cloud).', 400);
  return origin;
}

function issueView(i) {
  const f = (i && i.fields) || {};
  return {
    key: i.key,
    summary: f.summary || '',
    status: (f.status && f.status.name) || '',
    priority: (f.priority && f.priority.name) || '',
    dueDate: f.duedate || null,
  };
}

const PROJECT_RE = /^[A-Z][A-Z0-9_]+$/;

function checkKey(key) {
  const k = String(key || '').trim().toUpperCase();
  if (!KEY_RE.test(k)) throw new JiraError('Ungültige Ticketnummer.', 400);
  return k;
}
function checkId(id) {
  if (!/^\d+$/.test(String(id || ''))) throw new JiraError('Ungültige Kommentar-ID.', 400);
  return String(id);
}

/** Kommentar im Atlassian-Dokumentformat; "sd.public.comment" macht ihn in Service-Management-Projekten intern. */
function commentBody(text) {
  const lines = String(text || '').split('\n');
  return {
    body: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: lines.flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]) }],
    },
    properties: [{ key: 'sd.public.comment', value: { internal: true } }],
  };
}

function createClient({ baseUrl, email, token, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  const base = normalizeBaseUrl(baseUrl);
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

  async function request(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        redirect: 'error', // eine Weiterleitung auf einen anderen Server würde den Token mitschicken
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw new JiraError('Jira antwortet nicht (Zeitüberschreitung).', 504);
      throw new JiraError('Jira ist nicht erreichbar. Bitte Adresse und Internetverbindung prüfen.', 502);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      if (res.status === 401) throw new JiraError('Anmeldung bei Jira fehlgeschlagen: E-Mail oder API-Token stimmen nicht.', 401);
      if (res.status === 403) throw new JiraError('Jira verweigert den Zugriff (fehlende Berechtigung).', 403);
      if (res.status === 404) throw new JiraError('Nicht gefunden (Ticket existiert nicht oder ist nicht sichtbar).', 404);
      if (res.status === 429) throw new JiraError('Jira meldet zu viele Anfragen. Bitte kurz warten.', 429);
      throw new JiraError(`Jira-Fehler (${res.status}).`, 502);
    }
    if (res.status === 204) return null; // z. B. Kommentar gelöscht
    try { return await res.json(); } catch { throw new JiraError('Jira lieferte eine unlesbare Antwort.', 502); }
  }

  return {
    baseUrl: base,
    async myself() {
      const me = await request('GET', '/rest/api/3/myself');
      return { displayName: me.displayName || '', accountId: me.accountId || '' };
    },
    async issue(key) {
      const k = String(key || '').trim().toUpperCase();
      if (!KEY_RE.test(k)) throw new JiraError('Ungültige Ticketnummer.', 400);
      return issueView(await request('GET', `/rest/api/3/issue/${encodeURIComponent(k)}?fields=${FIELDS.join(',')}`));
    },
    /**
     * Ticket eines Tages im Projekt (Titel = Datum, z. B. "2026-11-20"), sonst null.
     * Gesucht wird per Volltext, verglichen wird genau.
     */
    async dailyIssue(project, date) {
      const p = String(project || '').trim().toUpperCase();
      if (!PROJECT_RE.test(p)) throw new JiraError('Ungültiger Projektschlüssel für das Tagesticket.', 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new JiraError('Ungültiges Datum.', 400);
      const data = await request('POST', '/rest/api/3/search/jql', { jql: `project = "${p}" AND summary ~ "\\"${date}\\"" ORDER BY created DESC`, fields: ['summary'], maxResults: 20 });
      const hit = (data.issues || []).find((i) => String((i.fields && i.fields.summary) || '').trim() === date);
      return hit ? hit.key : null;
    },
    /** Interner Kommentar (bei Service-Management-Projekten nur für das Team sichtbar). Gibt die Kommentar-ID zurück. */
    async addComment(key, text) {
      const k = checkKey(key);
      const r = await request('POST', `/rest/api/3/issue/${encodeURIComponent(k)}/comment`, commentBody(text));
      return String(r && r.id);
    },
    async updateComment(key, id, text) {
      const k = checkKey(key);
      await request('PUT', `/rest/api/3/issue/${encodeURIComponent(k)}/comment/${encodeURIComponent(checkId(id))}`, commentBody(text));
    },
    async deleteComment(key, id) {
      const k = checkKey(key);
      await request('DELETE', `/rest/api/3/issue/${encodeURIComponent(k)}/comment/${encodeURIComponent(checkId(id))}`);
    },
    async myIssues({ max = 50 } = {}) {
      const data = await request('POST', '/rest/api/3/search/jql', { jql: MY_ISSUES_JQL, fields: FIELDS, maxResults: Math.min(100, Math.max(1, max)) });
      return (data.issues || []).map(issueView);
    },
  };
}

module.exports = { BASE_RE, KEY_RE, PROJECT_RE, MY_ISSUES_JQL, JiraError, normalizeBaseUrl, createClient, commentBody };
