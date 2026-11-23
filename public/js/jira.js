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
    /** Meine Tickets mit den ausgeblendeten: {issues, ignored}. */
    myIssuesInfo() { return Api.get('/api/jira/my-issues'); },
    /** Ticket nie mehr vorschlagen (ignored = true) bzw. wieder vorschlagen. */
    setIgnored(key, ignored) { return Api.post('/api/jira/ignore', { key, ignored }); },
    /**
     * Einträge als interne Kommentare nach Jira schreiben. Vorher zeigt ein Dialog, welcher Text in welches Ticket
     * geht (eigenes Ticket, Ticket der Aufgabe oder Tagesticket). Gibt false zurück, wenn abgebrochen wurde oder nichts
     * zu tun war; das Ergebnis kommt als Hinweis mit den Tickets.
     */
    async postEntries(list) {
      if (!list.length) return false;
      const withTimes = loadShowTimes();
      let items;
      try {
        items = (await Api.post('/api/jira/comments/preview', { ids: list.map((e) => e.id), with_times: withTimes })).items;
      } catch (err) {
        showToast(err.message, { durationMs: 10000 });
        return false;
      }
      const ready = items.filter((i) => !i.error);
      if (!ready.length) { showToast(`Nicht möglich: ${items[0].error}`, { durationMs: 10000 }); return false; }
      if (!(await confirmPost(items))) return false;
      try {
        const { results } = await Api.post('/api/jira/comments', { ids: ready.map((i) => i.id), with_times: withTimes });
        reportResults(results);
      } catch (err) {
        showToast(err.message, { durationMs: 10000 });
      }
      return true;
    },
    /** Ticket in Jira öffnen (im Programmfenster über den Standardbrowser, dort ist man angemeldet). */
    async open(key) {
      const url = ZeitJira.ticketUrl(key);
      if (!url) return;
      if (window.zeitAppMode) {
        try {
          const r = await Api.post('/api/app/open-external', { url });
          if (r.opened) return;
        } catch { /* weiter mit dem Fallback */ }
      }
      window.open(url, '_blank', 'noopener');
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
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-jira-open]');
    if (!el || !base) return;
    e.preventDefault();
    e.stopPropagation();
    ZeitJira.open(el.dataset.jiraOpen);
  });

  // --- Schreiben: Rückfrage mit Vorschau und Ergebnis -------------------------------------------------------
  const SOURCE = {
    eintrag: () => 'Ticket des Eintrags',
    aufgabe: (i) => `Ticket der Aufgabe${i.taskTitle ? ` „${i.taskTitle}“` : ''}`,
    tagesticket: () => 'Tagesticket – für Einträge ohne Ticket',
  };
  const ACTION = { neu: '', aktualisieren: 'wird aktualisiert', verschieben: 'wird verschoben aus ' };
  const shortDate = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.` : '');

  /** Dialog: je Ticket die Kommentare im Wortlaut; Einträge mit Fehler stehen darunter. true = schreiben. */
  function confirmPost(items) {
    const ready = items.filter((i) => !i.error);
    const failed = items.filter((i) => i.error);
    const groups = new Map();
    for (const i of ready) {
      if (!groups.has(i.key)) groups.set(i.key, { ...i, list: [] });
      groups.get(i.key).list.push(i);
    }
    const manyDays = new Set(ready.map((i) => i.workDate)).size > 1;
    const n = ready.length;
    const dialog = document.createElement('dialog');
    dialog.className = 'jira-dialog';
    dialog.innerHTML = `
      <form method="dialog">
        <h2>Nach Jira schreiben</h2>
        <p class="jira-dialog__lead">${n === 1 ? 'Ein interner Kommentar' : `${n} interne Kommentare`} in ${groups.size === 1 ? 'dieses Ticket' : `${groups.size} Tickets`}:</p>
        <div class="jira-dialog__list">
          ${[...groups.values()].map((g) => `
            <section class="jira-dialog__group">
              <div class="jira-dialog__ticket">
                <span class="mono jira-dialog__key">${escapeHtml(g.key)}</span>
                <span class="jira-dialog__summary">${escapeHtml(g.summary || '')}</span>
              </div>
              <div class="jira-dialog__src${g.source === 'tagesticket' ? ' is-daily' : ''}">${escapeHtml(SOURCE[g.source](g))}</div>
              <ul>${g.list.map((i) => `<li>
                <span class="jira-dialog__text">${manyDays ? `<span class="mono">${shortDate(i.workDate)}</span> ` : ''}${escapeHtml(i.text)}</span>
                ${i.action !== 'neu' ? `<span class="jira-dialog__action">${escapeHtml(ACTION[i.action] + (i.from || ''))}</span>` : ''}
              </li>`).join('')}</ul>
            </section>`).join('')}
          ${failed.length ? `<div class="jira-dialog__failed"><strong>${failed.length === 1 ? 'Ein Eintrag wird' : `${failed.length} Einträge werden`} nicht geschrieben:</strong>
            ${[...new Set(failed.map((f) => f.error))].map((m) => `<div>${escapeHtml(m)}</div>`).join('')}</div>` : ''}
        </div>
        <div class="jira-dialog__actions">
          <button type="submit" value="cancel" class="btn btn--ghost">Abbrechen</button>
          <button type="submit" value="ok" class="btn">${n === 1 ? 'Kommentar schreiben' : `${n} Kommentare schreiben`}</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'ok'); dialog.remove(); });
      dialog.showModal();
      dialog.querySelector('button[value="ok"]').focus();
    });
  }

  /** Ergebnis: welche Tickets wie viele Kommentare bekommen haben, mit "In Jira öffnen" bei genau einem Ticket. */
  function reportResults(results) {
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const byKey = new Map();
    for (const r of ok) {
      if (!byKey.has(r.key)) byKey.set(r.key, { n: 0, daily: r.daily });
      byKey.get(r.key).n += 1;
    }
    const parts = [...byKey].map(([k, v]) => `${k}${v.daily ? ' (Tagesticket)' : ''}${v.n > 1 ? ` ×${v.n}` : ''}`);
    let msg = ok.length ? `${ok.length === 1 ? 'Kommentar' : `${ok.length} Kommentare`} geschrieben: ${parts.join(', ')}.` : '';
    if (failed.length) msg += `${msg ? ' ' : ''}${failed.length} nicht geschrieben: ${failed[0].error}`;
    const only = byKey.size === 1 ? [...byKey.keys()][0] : null;
    showToast(msg, { durationMs: 10000, ...(only ? { label: 'In Jira öffnen', onClick: () => ZeitJira.open(only) } : {}) });
  }

  // --- Einstellungskarte (account.html) ------------------------------------------------------------
  const card = document.getElementById('jiraCard');
  if (!card) return;
  const $ = (id) => document.getElementById(id);
  const el = {
    error: $('jiraError'), badge: $('jiraBadge'), url: $('jiraUrl'), email: $('jiraEmail'), token: $('jiraToken'),
    save: $('jiraSaveBtn'), test: $('jiraTestBtn'), clear: $('jiraClearBtn'),
    write: $('jiraWrite'), daily: $('jiraDailyProject'), dailyTest: $('jiraDailyTestBtn'),
    syncTasks: $('jiraSyncTasks'), notifyNew: $('jiraNotifyNew'),
    excludeProjects: $('jiraExcludeProjects'), jqlFilter: $('jiraJqlFilter'),
  };

  function show(s) {
    el.url.value = s.baseUrl || '';
    el.email.value = s.email || '';
    el.token.value = '';
    el.token.placeholder = s.hasToken ? 'Gespeichert – zum Ändern neuen Token einfügen' : 'API-Token einfügen';
    el.badge.textContent = s.configured ? (s.allowWrite ? 'eingerichtet · schreibt Kommentare' : 'eingerichtet · nur lesend') : 'nicht eingerichtet';
    el.write.checked = !!s.allowWrite;
    el.syncTasks.checked = s.syncTasks !== false;
    el.notifyNew.checked = s.notifyNew !== false;
    el.excludeProjects.value = s.excludeProjects || '';
    el.jqlFilter.value = s.jqlFilter || '';
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
        syncTasks: el.syncTasks.checked, notifyNew: el.notifyNew.checked,
        excludeProjects: el.excludeProjects.value, jqlFilter: el.jqlFilter.value,
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
