'use strict';

// Seite "Aufgaben": Ansichten links, Liste in der Mitte, die gewählte Aufgabe rechts (Änderungen werden
// automatisch gespeichert). Abgehakt wird nur von Hand. Der Timer startet mit Titel, Ticket und der Aufgabe.
(function () {
  const $ = (sel) => document.querySelector(sel);
  const el = {
    views: document.querySelectorAll('.tp-view'),
    heading: $('#tpHeading'),
    hint: $('#tpHint'),
    add: $('#tpAdd'),
    title: $('#tpTitle'),
    due: $('#tpDue'),
    custom: $('#tpCustom'),
    dueDate: $('#tpDueDate'),
    dueTime: $('#tpDueTime'),
    error: $('#tpError'),
    list: $('#tpList'),
    detail: $('#tpDetail'),
    jira: $('#tpJira'),
    jiraBtn: $('#tpJiraBtn'),
    importPanel: $('#tpImport'),
    banners: $('#tpBanners'),
    userLabel: $('#userLabel'),
    logout: $('#logoutBtn'),
  };

  const VIEW_KEY = 'zeit.tasksPageView';
  const VIEW_TITLE = { today: 'Heute', soon: 'Demnächst', none: 'Ohne Datum', all: 'Alle offenen', done: 'Erledigt' };
  const A = window.AufgabenHilfe;
  const ICON = A.ICON;
  const setHtml = A.htmlSetter();

  const state = { open: [], done: [], view: loadView(), selected: null, saving: null, newIssues: [], hideDone: false };

  function loadView() {
    try { const v = localStorage.getItem(VIEW_KEY); if (VIEW_TITLE[v]) return v; } catch { /* nur Komfort */ }
    return 'today';
  }

  const { dueText, repeatText, hm } = A;
  const choiceDate = A.dateForChoice;

  // --- Daten -------------------------------------------------------------------------------------------
  async function load() {
    try {
      const [open, done] = await Promise.all([Api.get('/api/tasks'), Api.get('/api/tasks?scope=done')]);
      state.open = open.tasks;
      state.done = done.tasks;
      if (state.selected && !findTask(state.selected)) state.selected = null;
      render();
    } catch (err) {
      setError(err.message);
    }
  }
  const findTask = (id) => state.open.find((t) => t.id === id) || state.done.find((t) => t.id === id);
  const setError = (m) => { el.error.textContent = m || ''; };

  function groups() {
    const today = todayISO();
    const o = state.open;
    return {
      overdue: o.filter((t) => t.dueDate && t.dueDate < today),
      today: o.filter((t) => t.dueDate === today),
      soon: o.filter((t) => t.dueDate && t.dueDate > today),
      none: o.filter((t) => !t.dueDate),
    };
  }

  // --- Anzeige -----------------------------------------------------------------------------------------

  function rowHtml(t, today) {
    const done = t.status === 'done';
    const overdue = !done && t.dueDate && t.dueDate < today;
    const sub = [t.jiraKey && t.title ? t.jiraKey : '', done ? 'erledigt' : dueText(t, today), t.repeat ? `↻ ${repeatText(t.repeat)}` : '',
      t.tracked && t.tracked.minutes ? `${hm(t.tracked.minutes)} erfasst` : ''].filter(Boolean).join(' · ');
    const jiraDone = t.jiraDone ? `<span class="tp-jira-done" title="Das Ticket ist in Jira erledigt – Aufgabe abhaken?">in Jira erledigt</span>` : '';
    return `
      <div class="tp-row${state.selected === t.id ? ' is-selected' : ''}${overdue ? ' is-overdue' : ''}${done ? ' is-done' : ''}" data-id="${t.id}">
        <button type="button" class="task__check${done ? ' is-on' : ''}" data-act="${done ? 'reopen' : 'done'}" aria-label="${done ? 'Wieder öffnen' : 'Als erledigt abhaken'}" title="${done ? 'Wieder öffnen' : 'Erledigt'}">${done ? ICON.check : ''}</button>
        <button type="button" class="tp-row__main" data-act="select">
          <span class="tp-row__title">${escapeHtml(t.title || t.jiraKey || '')}</span>
          <span class="tp-row__sub mono">${escapeHtml(sub)}</span>
        </button>
        ${jiraDone}
        ${t.priority ? '<span class="task__prio" title="Wichtig" aria-label="Wichtig">!</span>' : ''}
        ${done ? '' : `<button type="button" class="task__play" data-act="start" aria-label="Timer starten" title="Timer mit dieser Aufgabe starten">${ICON.play}</button>`}
      </div>`;
  }

  function section(label, tone, items, today) {
    if (!items.length) return '';
    return `<div class="tasks__group${tone ? ` tasks__group--${tone}` : ''}">
      <div class="tasks__label">${label} <span class="tasks__count">${items.length}</span></div>
      ${items.map((t) => rowHtml(t, today)).join('')}</div>`;
  }

  function render({ detail = true } = {}) {
    const today = todayISO();
    const g = groups();
    const counts = { today: g.overdue.length + g.today.length, soon: g.soon.length, none: g.none.length, all: state.open.length, done: state.done.length };
    document.querySelectorAll('[data-count]').forEach((n) => { n.textContent = counts[n.dataset.count] || ''; });
    el.views.forEach((b) => {
      const on = b.dataset.view === state.view;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    el.heading.textContent = VIEW_TITLE[state.view];
    el.hint.textContent = state.view === 'done' ? 'Zuletzt erledigte zuerst' : 'Sortiert nach Fälligkeit';

    let html = '';
    if (state.view === 'today') html = section('Überfällig', 'overdue', g.overdue, today) + section('Heute', '', g.today, today);
    else if (state.view === 'soon') html = section('Demnächst', '', g.soon, today);
    else if (state.view === 'none') html = section('Ohne Datum', '', g.none, today);
    else if (state.view === 'all') html = section('Überfällig', 'overdue', g.overdue, today) + section('Heute', '', g.today, today) + section('Demnächst', '', g.soon, today) + section('Ohne Datum', '', g.none, today);
    else html = state.done.length ? `<div class="tasks__group">${state.done.map((t) => rowHtml(t, today)).join('')}</div>` : '';
    if (!html) html = `<div class="tasks__empty">${state.view === 'today' ? 'Nichts offen für heute.' : state.view === 'done' ? 'Noch nichts erledigt.' : 'Keine Aufgaben in dieser Ansicht.'}</div>`;
    setHtml(el.list, html);
    renderBanners();
    if (detail) renderDetail();
  }

  /** Hinweise aus dem Jira-Abgleich: Tickets in Jira erledigt (Abhaken vorschlagen), neue Tickets für mich. */
  function renderBanners() {
    const jiraDone = state.open.filter((t) => t.jiraDone);
    let html = '';
    if (jiraDone.length && !state.hideDone) {
      const names = jiraDone.slice(0, 3).map((t) => `<span class="mono">${escapeHtml(t.jiraKey)}</span> ${escapeHtml(t.title || '')}`).join(', ');
      html += `<div class="tp-banner tp-banner--done">
        <span class="tp-banner__text"><strong>${jiraDone.length === 1 ? 'Ticket in Jira erledigt' : `${jiraDone.length} Tickets in Jira erledigt`}:</strong> ${names}${jiraDone.length > 3 ? ' …' : ''}</span>
        <span class="tp-banner__actions"><button type="button" class="btn btn--sm" data-banner="done-all">${jiraDone.length === 1 ? 'Abhaken' : 'Alle abhaken'}</button>
        <button type="button" class="btn btn--ghost btn--sm" data-banner="done-hide">Später</button></span>
      </div>`;
    }
    if (state.newIssues.length) {
      const names = state.newIssues.slice(0, 3).map((i) => `<span class="mono">${escapeHtml(i.key)}</span> ${escapeHtml(i.summary)}`).join(', ');
      html += `<div class="tp-banner">
        <span class="tp-banner__text"><strong>${state.newIssues.length === 1 ? 'Neues Ticket für dich' : `${state.newIssues.length} neue Tickets für dich`}:</strong> ${names}${state.newIssues.length > 3 ? ' …' : ''}</span>
        <span class="tp-banner__actions"><button type="button" class="btn btn--sm" data-banner="import">Übernehmen …</button>
        <button type="button" class="btn btn--ghost btn--sm" data-banner="new-hide">Ausblenden</button></span>
      </div>`;
    }
    setHtml(el.banners, html);
  }

  /** Jira-Abgleich beim Öffnen der Seite (der Server fragt höchstens alle 5 Minuten bei Jira nach). */
  async function syncJira() {
    try {
      const r = await Api.post('/api/jira/sync');
      if (!r || r.skipped || r.configured === false) return;
      if (r.newIssues && r.newIssues.length) state.newIssues = r.newIssues;
      if ((r.doneTasks && r.doneTasks.length) || state.newIssues.length) await load();
    } catch { /* Jira nicht erreichbar: die Seite funktioniert trotzdem */ }
  }

  function renderDetail() {
    const t = state.selected ? findTask(state.selected) : null;
    el.detail.classList.toggle('hidden', !t);
    document.querySelector('.tasks-page').classList.toggle('has-detail', !!t);
    if (!t) { setHtml(el.detail, ''); return; }
    const r = t.repeat;
    const simple = !r || (r.every === 1 && r.mode === 'due');
    const done = t.status === 'done';
    setHtml(el.detail, `
      <form class="tp-form" data-id="${t.id}" autocomplete="off">
        <div class="tp-form__head">
          <span class="tp-label">Aufgabe${done ? ' · erledigt' : ''}</span>
          <span class="tp-saved" id="tpSaved" aria-live="polite"></span>
          <button type="button" class="icon-btn" data-act="close" aria-label="Schließen" title="Schließen">${ICON.close}</button>
        </div>
        <label class="visually-hidden" for="tpfTitle">Titel</label>
        <textarea id="tpfTitle" name="title" rows="2" maxlength="500" class="tp-form__title">${escapeHtml(t.title)}</textarea>

        <div class="tp-ticket">
          <label class="tp-field">Ticket
            <input type="text" name="jira" class="mono" maxlength="500" value="${escapeHtml(t.jiraKey || '')}" placeholder="z. B. ITPKK-123" />
          </label>
          ${t.jiraKey ? `<button type="button" class="tp-jira-open" data-jira-open="${escapeHtml(t.jiraKey)}" title="In Jira öffnen">${ICON.external}<span>In Jira</span></button>` : ''}
        </div>
        <div class="tp-jira-info" id="tpJiraInfo"></div>
        ${t.jiraDone ? `<div class="tp-jira-suggest">
          <span>Das Ticket ist in Jira erledigt${t.jiraStatus ? ` (Status „${escapeHtml(t.jiraStatus)}“)` : ''}. Aufgabe abhaken?</span>
          <button type="button" class="btn btn--sm" data-act="done">Abhaken</button>
          <button type="button" class="btn btn--ghost btn--sm" data-act="jira-dismiss">Nicht abhaken</button>
        </div>` : ''}

        <div class="tp-grid">
          <label class="tp-field">Fällig am <input type="date" name="date" value="${t.dueDate || ''}" /></label>
          <label class="tp-field">Uhrzeit <input type="time" name="time" value="${t.dueTime || ''}" /></label>
        </div>
        <div class="tp-chips" role="group" aria-label="Fälligkeit schnell setzen">
          <button type="button" class="chip" data-due="today">Heute</button>
          <button type="button" class="chip" data-due="tomorrow">Morgen</button>
          <button type="button" class="chip" data-due="monday">Montag</button>
          <button type="button" class="chip" data-due="week">+1 Woche</button>
          <button type="button" class="chip" data-due="none">Ohne Datum</button>
        </div>
        <div class="tp-grid">
          <label class="tp-field">Wiederholen
            <select name="repeat">
              <option value=""${!r ? ' selected' : ''}>Nie</option>
              <option value="day"${r && simple && r.unit === 'day' ? ' selected' : ''}>Täglich</option>
              <option value="week"${r && simple && r.unit === 'week' ? ' selected' : ''}>Wöchentlich</option>
              <option value="month"${r && simple && r.unit === 'month' ? ' selected' : ''}>Monatlich</option>
              ${r && !simple ? `<option value="keep" selected>${escapeHtml(repeatText(r))}${r.mode === 'done' ? ' (ab Erledigung)' : ''}</option>` : ''}
            </select>
          </label>
          <label class="tp-field tp-field--check"><input type="checkbox" name="prio"${t.priority ? ' checked' : ''} /> Wichtig</label>
        </div>
        <label class="tp-field">Notiz
          <textarea name="note" rows="3" maxlength="4000" placeholder="Was ist noch zu tun?">${escapeHtml(t.note || '')}</textarea>
        </label>
        <div class="tp-tracked">
          <span>Schon erfasst</span>
          <strong class="mono">${hm((t.tracked && t.tracked.minutes) || 0)}</strong>
          <span class="tp-tracked__n">${t.tracked && t.tracked.count ? `in ${t.tracked.count} Eintr${t.tracked.count === 1 ? 'ag' : 'ägen'}` : 'noch nichts'}</span>
        </div>
        <div class="tp-error" id="tpFormError"></div>
        <div class="tp-actions">
          ${done ? '<button type="button" class="btn" data-act="reopen">Wieder öffnen</button>'
            : `<button type="button" class="btn tp-actions__start" data-act="start">${ICON.play}Timer starten</button>
               <button type="button" class="btn btn--secondary" data-act="done">Erledigt</button>`}
          <button type="button" class="icon-btn tp-actions__delete" data-act="delete" aria-label="Löschen" title="Löschen">${ICON.trash}</button>
        </div>
      </form>`);
    loadJiraInfo(t);
  }

  async function loadJiraInfo(t) {
    const box = $('#tpJiraInfo');
    if (!box || !t.jiraKey || !window.ZeitJira) return;
    const issue = await window.ZeitJira.issue(t.jiraKey);
    if (!issue || state.selected !== t.id) return;
    const target = $('#tpJiraInfo');
    if (target) target.textContent = [issue.status && `Jira: ${issue.status}`, issue.priority && `Priorität ${issue.priority}`, issue.dueDate && `fällig ${issue.dueDate}`].filter(Boolean).join(' · ');
  }

  // --- Aktionen ----------------------------------------------------------------------------------------
  async function addTask() {
    const input = await A.parseQuickInput(el.title.value);
    if (!input) return;
    const { title, key } = input;
    const dueDate = choiceDate(el.due.value, el.dueDate.value);
    if (dueDate === undefined) { setError('Bitte ein Datum wählen.'); return; }
    setError('');
    try {
      const r = await Api.post('/api/tasks', { title, jira_key: key, due_date: dueDate, due_time: dueDate && el.due.value === 'custom' && el.dueTime.value ? el.dueTime.value : null });
      el.title.value = '';
      await load();
      // die neue Aufgabe in einer Ansicht zeigen, in der sie auch steht
      if (!['all'].includes(state.view)) {
        const t = r.task; const today = todayISO();
        const fits = state.view === 'today' ? t.dueDate && t.dueDate <= today : state.view === 'soon' ? t.dueDate > today : state.view === 'none' ? !t.dueDate : false;
        if (!fits) showToast('Aufgabe angelegt – sie steht in einer anderen Ansicht.', { label: 'Zeigen', onClick: () => { state.view = 'all'; state.selected = t.id; render(); } });
      }
    } catch (err) { setError(err.message); }
  }

  function formBody(form) {
    const f = new FormData(form);
    const body = {
      title: String(f.get('title') || '').trim(),
      jira_key: String(f.get('jira') || '').trim() || null,
      due_date: f.get('date') || null,
      due_time: f.get('date') ? f.get('time') || null : null,
      priority: f.get('prio') ? 1 : 0,
      note: String(f.get('note') || ''),
    };
    const rep = f.get('repeat');
    if (rep === '') body.repeat = null; else if (rep !== 'keep') body.repeat = { every: 1, unit: rep, mode: 'due' };
    return body;
  }

  let saveTimer = null;
  function scheduleSave(form, delay = 500) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(form), delay);
  }
  async function save(form) {
    const id = Number(form.dataset.id);
    const errBox = $('#tpFormError');
    const status = $('#tpSaved');
    try {
      const r = await Api.put(`/api/tasks/${id}`, formBody(form));
      if (errBox) errBox.textContent = '';
      // Liste aktualisieren, ohne das Formular neu zu zeichnen (Eingaben bleiben stehen)
      const i = state.open.findIndex((t) => t.id === id);
      if (i >= 0) state.open[i] = { ...state.open[i], ...r.task };
      const j = state.done.findIndex((t) => t.id === id);
      if (j >= 0) state.done[j] = { ...state.done[j], ...r.task };
      renderListOnly();
      if (status) { status.textContent = 'Gespeichert'; setTimeout(() => { if (status) status.textContent = ''; }, 1500); }
    } catch (err) {
      if (errBox) errBox.textContent = err.message;
    }
  }
  // Liste neu zeichnen, das Formular aber stehen lassen (Eingabe und Cursor bleiben erhalten)
  const renderListOnly = () => render({ detail: false });

  async function setDone(id, done) {
    if (done && state.selected === id) state.selected = null;
    const data = await A.setDone(id, done, load);
    // Wiederholung: die neue Aufgabe gleich auswählen
    if (data && data.next && done) { state.selected = data.next.id; render(); }
  }

  async function dismissJiraHint(id) {
    try {
      await Api.post(`/api/tasks/${id}/jira-hint/dismiss`);
      await load();
    } catch (err) {
      showToast(err.message);
    }
  }

  /** Alle Aufgaben abhaken, deren Ticket in Jira erledigt ist (mit Rückgängig über den Hinweis). */
  async function doneAllFromJira() {
    const list = state.open.filter((t) => t.jiraDone);
    let ok = 0;
    for (const t of list) {
      try { await Api.patch(`/api/tasks/${t.id}/done`, { done: true }); ok += 1; } catch (err) { showToast(err.message); }
    }
    if (list.some((t) => t.id === state.selected)) state.selected = null;
    await load();
    if (ok) {
      showToast(`${ok} Aufgabe${ok === 1 ? '' : 'n'} abgehakt.`, {
        label: 'Rückgängig',
        onClick: async () => {
          for (const t of list) await Api.patch(`/api/tasks/${t.id}/done`, { done: false }).catch(() => {});
          await load();
        },
      });
    }
  }

  async function removeTask(id) {
    if (state.selected === id) state.selected = null;
    await A.remove(id, load);
  }

  async function startTimer(t) {
    const pad2 = (n) => String(n).padStart(2, '0');
    const now = new Date();
    try {
      await Api.post('/api/timer', { work_date: todayISO(), start_time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`, description: '', jira_key: t.jiraKey || null, task_id: t.id });
      showToast(`Timer läuft für „${t.title || t.jiraKey}“.`, { label: 'Zu Heute', durationMs: 8000, onClick: () => { window.location.href = '/index.html'; } });
    } catch (err) {
      showToast(err.status === 409 ? 'Es läuft schon ein Timer – erst stoppen oder unterbrechen (Seite „Heute“).' : err.message);
    }
  }

  // --- Jira-Import -------------------------------------------------------------------------------------
  // "Meine Tickets holen": nichts ist vorausgewählt (bewusst auswählen statt alles übernehmen); wichtige und fällige
  // Tickets stehen oben. Einzelne Tickets lassen sich dauerhaft ausblenden und unten wieder einblenden.
  const imp = { issues: [], ignored: [], showIgnored: false, preselect: new Set() };
  const PRIO_RANK = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
  const importRank = (i) => [/^(highest|high)$/i.test(i.priority) ? 0 : 1, i.dueDate || '9999', PRIO_RANK[String(i.priority).toLowerCase()] ?? 2];
  const cmpRank = (a, b) => { const x = importRank(a); const y = importRank(b); return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2]; };

  async function openImport(preselectKeys = []) {
    imp.preselect = new Set(preselectKeys);
    el.importPanel.classList.remove('hidden');
    el.importPanel.textContent = 'Lade deine Tickets …';
    try {
      const info = await window.ZeitJira.myIssuesInfo();
      const have = new Set([...state.open, ...state.done].map((t) => (t.jiraKey || '').toUpperCase()));
      imp.issues = info.issues.filter((i) => !have.has(i.key.toUpperCase())).sort(cmpRank);
      imp.ignored = info.ignored || [];
      renderImport();
    } catch (err) {
      el.importPanel.innerHTML = `<div class="tasks__error">${escapeHtml(err.message)}</div><button type="button" class="btn btn--ghost btn--sm" data-act="close">Schließen</button>`;
    }
  }

  function importRow(i, n) {
    const today = todayISO();
    const sub = [i.key, i.status, i.priority && /^(highest|high)$/i.test(i.priority) ? `Priorität ${i.priority}` : '',
      i.dueDate ? `fällig ${i.dueDate < today ? 'seit ' : ''}${i.dueDate.slice(8, 10)}.${i.dueDate.slice(5, 7)}.` : ''].filter(Boolean).join(' · ');
    return `<div class="import__row${/^(highest|high)$/i.test(i.priority) ? ' is-important' : ''}">
      <label class="import__pick"><input type="checkbox" data-n="${n}"${imp.preselect.has(i.key) ? ' checked' : ''} />
        <span class="import__text"><span class="import__title">${escapeHtml(i.summary || i.key)}</span><span class="import__sub mono">${escapeHtml(sub)}</span></span>
      </label>
      <button type="button" class="import__hide" data-ignore="${escapeHtml(i.key)}" title="Dieses Ticket nie mehr vorschlagen">Ausblenden</button>
    </div>`;
  }

  function renderImport() {
    const ignoredHtml = imp.ignored.length ? `
      <button type="button" class="import__ignored-toggle" data-act="toggle-ignored">${imp.ignored.length} ausgeblendet${imp.showIgnored ? ' – zuklappen' : ' – anzeigen'}</button>
      ${imp.showIgnored ? imp.ignored.map((i) => `<div class="import__row is-ignored"><span class="import__text"><span class="import__title">${escapeHtml(i.summary || i.key)}</span>
        <span class="import__sub mono">${escapeHtml(i.key)}</span></span><button type="button" class="import__hide" data-unignore="${escapeHtml(i.key)}">Wieder vorschlagen</button></div>`).join('') : ''}` : '';
    el.importPanel.innerHTML = imp.issues.length ? `
      <div class="import__head"><span>Offene Jira-Tickets von dir · ${imp.issues.length}</span>
        <span class="import__head-actions"><button type="button" class="import__link" data-act="select-all">Alle</button><button type="button" class="import__link" data-act="select-none">Keine</button></span></div>
      <div class="import__hint">Wähle aus, was du als Aufgabe brauchst. Was dich nicht betrifft: „Ausblenden“.</div>
      ${imp.issues.map(importRow).join('')}
      ${ignoredHtml}
      <label class="import__due">Fällig am <select id="tpImportDue"><option value="jira">Jira-Termin (sonst ohne Datum)</option><option value="today">Heute</option><option value="none">Ohne Datum</option></select></label>
      <div class="import__actions"><button type="button" class="btn btn--ghost btn--sm" data-act="close">Schließen</button><span class="task-edit__spacer"></span><button type="button" class="btn btn--sm" data-act="apply">Auswahl übernehmen</button></div>`
      : `<div class="tasks__empty">Keine neuen Tickets – alle sind schon Aufgaben oder ausgeblendet.</div>${ignoredHtml}<button type="button" class="btn btn--ghost btn--sm" data-act="close">Schließen</button>`;
  }

  async function setIgnored(key, ignored) {
    try {
      await window.ZeitJira.setIgnored(key, ignored);
      const from = ignored ? imp.issues : imp.ignored;
      const item = from.find((i) => i.key === key);
      if (ignored) { imp.issues = imp.issues.filter((i) => i.key !== key); if (item) imp.ignored.push(item); }
      else { imp.ignored = imp.ignored.filter((i) => i.key !== key); if (item) imp.issues = [...imp.issues, item].sort(cmpRank); }
      renderImport();
      if (ignored) showToast(`${key} wird nicht mehr vorgeschlagen.`, { label: 'Rückgängig', durationMs: 8000, onClick: () => setIgnored(key, false) });
    } catch (err) {
      showToast(err.message);
    }
  }
  async function applyImport() {
    const mode = $('#tpImportDue').value;
    const picked = [...el.importPanel.querySelectorAll('input[data-n]:checked')].map((c) => imp.issues[Number(c.dataset.n)]);
    if (!picked.length) { showToast('Bitte mindestens ein Ticket auswählen.'); return; }
    let ok = 0;
    for (const i of picked) {
      try {
        await Api.post('/api/tasks', { title: i.summary, jira_key: i.key, due_date: (mode === 'today' ? todayISO() : mode === 'jira' ? i.dueDate : null) || null, priority: /^(highest|high)$/i.test(i.priority) ? 1 : 0 });
        ok += 1;
      } catch (err) { setError(err.message); }
    }
    el.importPanel.classList.add('hidden');
    await load();
    showToast(`${ok} Aufgabe${ok === 1 ? '' : 'n'} aus Jira übernommen.`);
  }

  // --- Ereignisse --------------------------------------------------------------------------------------
  el.views.forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    try { localStorage.setItem(VIEW_KEY, state.view); } catch { /* nur Komfort */ }
    render();
  }));
  el.add.addEventListener('submit', (e) => { e.preventDefault(); addTask(); });
  el.due.addEventListener('change', () => {
    const custom = el.due.value === 'custom';
    el.custom.classList.toggle('hidden', !custom);
    if (custom && !el.dueDate.value) el.dueDate.value = todayISO();
  });

  el.list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const row = e.target.closest('[data-id]');
    if (!btn || !row) return;
    const id = Number(row.dataset.id);
    const t = findTask(id);
    if (btn.dataset.act === 'select') { state.selected = state.selected === id ? null : id; render(); history.replaceState(null, '', state.selected ? `#aufgabe-${id}` : location.pathname); }
    else if (btn.dataset.act === 'done') setDone(id, true);
    else if (btn.dataset.act === 'reopen') setDone(id, false);
    else if (btn.dataset.act === 'start' && t) startTimer(t);
  });

  el.detail.addEventListener('input', (e) => { const form = e.target.closest('.tp-form'); if (form && e.target.matches('textarea, input[type="text"]')) scheduleSave(form, 700); });
  el.detail.addEventListener('change', (e) => { const form = e.target.closest('.tp-form'); if (form) scheduleSave(form, 50); });
  el.detail.addEventListener('submit', (e) => e.preventDefault());
  el.detail.addEventListener('click', (e) => {
    const form = e.target.closest('.tp-form');
    if (!form) return;
    const id = Number(form.dataset.id);
    const t = findTask(id);
    const chip = e.target.closest('[data-due]');
    if (chip) {
      const date = choiceDate(chip.dataset.due);
      form.elements.date.value = date || '';
      if (!date) form.elements.time.value = '';
      scheduleSave(form, 50);
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'close') { state.selected = null; render(); history.replaceState(null, '', location.pathname); }
    else if (btn.dataset.act === 'done') setDone(id, true);
    else if (btn.dataset.act === 'reopen') setDone(id, false);
    else if (btn.dataset.act === 'delete') removeTask(id);
    else if (btn.dataset.act === 'jira-dismiss') dismissJiraHint(id);
    else if (btn.dataset.act === 'start' && t) { clearTimeout(saveTimer); save(form).then(() => startTimer(findTask(id) || t)); }
  });

  el.banners.addEventListener('click', (e) => {
    const b = e.target.closest('[data-banner]');
    if (!b) return;
    const act = b.dataset.banner;
    if (act === 'done-all') doneAllFromJira();
    else if (act === 'done-hide') { state.hideDone = true; renderBanners(); }
    else if (act === 'new-hide') { state.newIssues = []; renderBanners(); }
    else if (act === 'import') { const keys = state.newIssues.map((i) => i.key); state.newIssues = []; renderBanners(); openImport(keys); }
  });

  el.importPanel.addEventListener('click', (e) => {
    const hide = e.target.closest('[data-ignore], [data-unignore]');
    if (hide) { setIgnored(hide.dataset.ignore || hide.dataset.unignore, !!hide.dataset.ignore); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') el.importPanel.classList.add('hidden');
    else if (b.dataset.act === 'apply') applyImport();
    else if (b.dataset.act === 'toggle-ignored') { imp.showIgnored = !imp.showIgnored; renderImport(); }
    else if (b.dataset.act === 'select-all' || b.dataset.act === 'select-none') {
      el.importPanel.querySelectorAll('input[data-n]').forEach((c) => { c.checked = b.dataset.act === 'select-all'; });
    }
  });
  if (window.ZeitJira) {
    window.ZeitJira.settings().then((s) => { if (s.configured) el.jira.classList.remove('hidden'); });
    window.ZeitJira.settings().then((s) => { if (s.configured && (s.syncTasks || s.notifyNew)) syncJira(); });
    el.jiraBtn.addEventListener('click', () => openImport());
  }

  el.logout.addEventListener('click', async () => {
    try { await Api.post('/api/auth/logout'); } catch { /* egal */ }
    window.location.href = '/login.html';
  });
  window.addEventListener('focus', () => { if (!document.activeElement || !el.detail.contains(document.activeElement)) load(); });

  (async function init() {
    let me;
    try { me = await Api.get('/api/auth/me'); } catch { return; }
    el.userLabel.textContent = me.user.displayName;
    if (me.user.role === 'admin') document.getElementById('adminNavLink').classList.remove('hidden');
    await Api.primeCsrf();
    const m = location.hash.match(/^#aufgabe-(\d+)$/);
    if (m) { state.selected = Number(m[1]); }
    await load();
    if (m && findTask(Number(m[1]))) {
      const t = findTask(Number(m[1]));
      const today = todayISO();
      state.view = t.status === 'done' ? 'done' : !t.dueDate ? 'none' : t.dueDate > today ? 'soon' : 'today';
      render();
    }
  })();
})();
