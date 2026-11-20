'use strict';

// Jira-Anbindung im Browser (optional): gemeinsame Abfragen für die Erfassungsseite (Ticket-Titel, eigene Tickets),
// Einträge als Kommentare schreiben und die Einstellungskarte unter Konto. Das API-Token liegt nur verschlüsselt auf dem Server.
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
    /**
     * Einträge als interne Kommentare nach Jira schreiben (bei mehreren mit Rückfrage und Übersicht je Ticket).
     * Gibt false zurück, wenn abgebrochen wurde oder nichts zu tun war; Ergebnis und Fehler kommen als Hinweis.
     */
    async postEntries(list) {
      if (!list.length) return false;
      if (list.length > 1) {
        const byKey = new Map();
        for (const e of list) { const k = e.jiraKey || 'Tagesticket'; byKey.set(k, (byKey.get(k) || 0) + 1); }
        const lines = [...byKey].map(([k, n]) => `${k}: ${n} Eintr${n === 1 ? 'ag' : 'äge'}`).join('\n');
        if (!window.confirm(`${list.length} Einträge als interne Kommentare nach Jira schreiben?\n\n${lines}`)) return false;
      }
      try {
        const { results } = await Api.post('/api/jira/comments', { ids: list.map((e) => e.id), with_times: loadShowTimes() });
        const ok = results.filter((r) => r.ok);
        const failed = results.filter((r) => !r.ok);
        if (!failed.length) {
          showToast(ok.length === 1 ? `In ${ok[0].key} eingetragen${ok[0].daily ? ' (Tagesticket)' : ''}.` : `${ok.length} Einträge nach Jira geschrieben.`);
        } else {
          showToast(`${ok.length} geschrieben, ${failed.length} nicht: ${failed[0].error}`, { durationMs: 10000 });
        }
      } catch (err) {
        showToast(err.message);
      }
      return true;
    },
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
    document.documentElement.classList.toggle('jira-write', !!s.allowWrite);
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
  const el = {
    error: $('jiraError'), badge: $('jiraBadge'), url: $('jiraUrl'), email: $('jiraEmail'), token: $('jiraToken'),
    save: $('jiraSaveBtn'), test: $('jiraTestBtn'), clear: $('jiraClearBtn'),
    write: $('jiraWrite'), daily: $('jiraDailyProject'), dailyTest: $('jiraDailyTestBtn'),
  };

  function show(s) {
    el.url.value = s.baseUrl || '';
    el.email.value = s.email || '';
    el.token.value = '';
    el.token.placeholder = s.hasToken ? 'Gespeichert – zum Ändern neuen Token einfügen' : 'API-Token einfügen';
    el.badge.textContent = s.configured ? (s.allowWrite ? 'eingerichtet · schreibt Kommentare' : 'eingerichtet · nur lesend') : 'nicht eingerichtet';
    el.write.checked = !!s.allowWrite;
    el.daily.value = s.dailyProject || '';
    el.dailyTest.disabled = !s.configured || !s.dailyProject;
    el.test.disabled = !s.configured;
    el.clear.disabled = !s.hasToken;
  }

  ZeitJira.settings(true).then(show);

  el.save.addEventListener('click', async () => {
    setFormError(el.error, '');
    el.save.disabled = true;
    try {
      const s = await Api.put('/api/jira/settings', {
        baseUrl: el.url.value, email: el.email.value, apiToken: el.token.value,
        allowWrite: el.write.checked, dailyProject: el.daily.value,
      });
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
  el.dailyTest.addEventListener('click', async () => {
    setFormError(el.error, '');
    try {
      const r = await Api.get(`/api/jira/daily/${todayISO()}`);
      showToast(r.key ? `Tagesticket für heute: ${r.key}` : `Für heute (${todayISO()}) gibt es noch kein Tagesticket.`);
    } catch (err) {
      setFormError(el.error, err.message);
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
