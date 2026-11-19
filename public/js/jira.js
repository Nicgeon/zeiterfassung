'use strict';

// Jira-Anbindung im Browser (optional, nur lesend): gemeinsame Abfragen für die Erfassungsseite (Ticket-Titel, eigene
// Tickets) und die Einstellungskarte unter Konto. Das API-Token liegt nur verschlüsselt auf dem Server.
(function () {
  const cache = new Map();
  let settingsPromise = null;

  const ZeitJira = {
    /** Einstellungen ({configured, baseUrl, email, hasToken}); ohne Anmeldung/Fehler: nicht eingerichtet. */
    settings(force) {
      if (!settingsPromise || force) settingsPromise = Api.get('/api/jira/settings').catch(() => ({ configured: false }));
      return settingsPromise;
    },
    async configured() { return !!(await this.settings()).configured; },
    /** Titel usw. zu einer Ticketnummer (null, wenn nicht eingerichtet oder nicht auffindbar). */
    async issue(key) {
      const k = String(key || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(k) || !(await this.configured())) return null;
      if (cache.has(k)) return cache.get(k);
      try {
        const r = await Api.get(`/api/jira/issue/${encodeURIComponent(k)}`);
        cache.set(k, r.issue);
        return r.issue;
      } catch { return null; }
    },
    async myIssues() { return (await Api.get('/api/jira/my-issues')).issues; },
    reset() { settingsPromise = null; cache.clear(); },
  };
  window.ZeitJira = ZeitJira;

  // Ticketnummern auf der Seite (data-jira-open) öffnen das Ticket in Jira, sobald Jira eingerichtet ist.
  // Im Programmfenster geht der Link über den Server in den Standardbrowser (dort ist man bei Jira angemeldet).
  let base = '';
  ZeitJira.settings().then((s) => {
    if (!s.configured) return;
    base = s.baseUrl;
    document.documentElement.classList.add('jira-on');
  });
  ZeitJira.ticketUrl = (key) => (base ? `${base}/browse/${encodeURIComponent(String(key).toUpperCase())}` : '');
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-jira-open]');
    if (!el || !base) return;
    e.preventDefault();
    e.stopPropagation();
    const url = ZeitJira.ticketUrl(el.dataset.jiraOpen);
    if (!url) return;
    if (window.zeitAppMode) {
      try {
        const r = await Api.post('/api/app/open-external', { url });
        if (r.opened) return;
      } catch { /* weiter mit dem Fallback */ }
    }
    window.open(url, '_blank', 'noopener');
  });

  // --- Einstellungskarte (account.html) ------------------------------------------------------------
  const card = document.getElementById('jiraCard');
  if (!card) return;
  const $ = (id) => document.getElementById(id);
  const el = { error: $('jiraError'), badge: $('jiraBadge'), url: $('jiraUrl'), email: $('jiraEmail'), token: $('jiraToken'), save: $('jiraSaveBtn'), test: $('jiraTestBtn'), clear: $('jiraClearBtn') };

  function show(s) {
    el.url.value = s.baseUrl || '';
    el.email.value = s.email || '';
    el.token.value = '';
    el.token.placeholder = s.hasToken ? 'Gespeichert – zum Ändern neuen Token einfügen' : 'API-Token einfügen';
    el.badge.textContent = s.configured ? 'eingerichtet' : 'nicht eingerichtet';
    el.test.disabled = !s.configured;
    el.clear.disabled = !s.hasToken;
  }

  ZeitJira.settings(true).then(show);

  el.save.addEventListener('click', async () => {
    setFormError(el.error, '');
    el.save.disabled = true;
    try {
      const s = await Api.put('/api/jira/settings', { baseUrl: el.url.value, email: el.email.value, apiToken: el.token.value });
      ZeitJira.reset();
      show(s);
      showToast('Jira-Zugang gespeichert.');
    } catch (err) {
      setFormError(el.error, err.message);
    } finally {
      el.save.disabled = false;
    }
  });
  el.test.addEventListener('click', async () => {
    setFormError(el.error, '');
    el.test.disabled = true;
    try {
      const r = await Api.post('/api/jira/test');
      showToast(`Verbunden mit Jira${r.displayName ? ` als ${r.displayName}` : ''}.`);
    } catch (err) {
      setFormError(el.error, err.message);
    } finally {
      el.test.disabled = false;
    }
  });
  el.clear.addEventListener('click', async () => {
    if (!window.confirm('Jira-Zugang (Adresse, E-Mail und Token) von diesem Konto entfernen?')) return;
    try {
      show(await Api.del('/api/jira/settings'));
      ZeitJira.reset();
      showToast('Jira-Zugang entfernt.');
    } catch (err) {
      setFormError(el.error, err.message);
    }
  });
})();
