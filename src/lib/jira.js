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
    async myIssues({ max = 50 } = {}) {
      const data = await request('POST', '/rest/api/3/search/jql', { jql: MY_ISSUES_JQL, fields: FIELDS, maxResults: Math.min(100, Math.max(1, max)) });
      return (data.issues || []).map(issueView);
    },
  };
}

module.exports = { BASE_RE, KEY_RE, MY_ISSUES_JQL, JiraError, normalizeBaseUrl, createClient };
