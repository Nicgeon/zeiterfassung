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
    userLabel: $('#userLabel'),
    logout: $('#logoutBtn'),
  };

  const VIEW_KEY = 'zeit.tasksPageView';
  const VIEW_TITLE = { today: 'Heute', soon: 'Demnächst', none: 'Ohne Datum', all: 'Alle offenen', done: 'Erledigt' };
  const KEY_RE = /\b[A-Z][A-Z0-9_]+-\d+\b/;
  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  const state = { open: [], done: [], view: loadView(), selected: null, saving: null };

  function loadView() {
    try { const v = localStorage.getItem(VIEW_KEY); if (VIEW_TITLE[v]) return v; } catch { /* nur Komfort */ }
    return 'today';
  }

  // --- Datum -------------------------------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function addDaysISO(dateStr, days) { const [y, m, d] = dateStr.split('-').map(Number); return iso(new Date(y, m - 1, d + days)); }
  function nextMonday(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); const wd = (new Date(y, m - 1, d).getDay() + 6) % 7; return addDaysISO(dateStr, 7 - wd); }
  function addMonthsISO(dateStr, months) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const total = y * 12 + (m - 1) + months;
    const ny = Math.floor(total / 12); const nm = total % 12;
    return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, new Date(ny, nm + 1, 0).getDate()))}`;
  }
  const dayLabel = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace(',', ''); };
  function dueText(t, today) {
    if (!t.dueDate) return '';
    const time = t.dueTime ? ` ${t.dueTime}` : '';
    if (t.dueDate < today) return `überfällig seit ${dayLabel(t.dueDate)}`;
    if (t.dueDate === today) return t.dueTime ? `heute ${t.dueTime}` : 'heute';
    if (t.dueDate === addDaysISO(today, 1)) return `morgen${time}`;
    return `${dayLabel(t.dueDate)}${time}`;
  }
  const repeatText = (r) => (!r ? '' : r.every === 1 ? { day: 'täglich', week: 'wöchentlich', month: 'monatlich' }[r.unit] : `alle ${r.every} ${{ day: 'Tage', week: 'Wochen', month: 'Monate' }[r.unit]}`);
  const hm = (min) => `${Math.floor(min / 60)}:${pad(min % 60)}`;
  function choiceDate(choice, customDate) {
    const today = todayISO();
    return { today, tomorrow: addDaysISO(today, 1), dayafter: addDaysISO(today, 2), monday: nextMonday(today), week: addDaysISO(today, 7), month: addMonthsISO(today, 1), custom: customDate || undefined, none: null }[choice];
  }

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
  const rendered = new WeakMap();
  function setHtml(node, html) { if (rendered.get(node) === html) return; rendered.set(node, html); node.innerHTML = html; }

  function rowHtml(t, today) {
    const done = t.status === 'done';
    const overdue = !done && t.dueDate && t.dueDate < today;
    const sub = [t.jiraKey && t.title ? t.jiraKey : '', done ? 'erledigt' : dueText(t, today), t.repeat ? `↻ ${repeatText(t.repeat)}` : '',
      t.tracked && t.tracked.minutes ? `${hm(t.tracked.minutes)} erfasst` : ''].filter(Boolean).join(' · ');
    return `
      <div class="tp-row${state.selected === t.id ? ' is-selected' : ''}${overdue ? ' is-overdue' : ''}${done ? ' is-done' : ''}" data-id="${t.id}">
        <button type="button" class="task__check${done ? ' is-on' : ''}" data-act="${done ? 'reopen' : 'done'}" aria-label="${done ? 'Wieder öffnen' : 'Als erledigt abhaken'}" title="${done ? 'Wieder öffnen' : 'Erledigt'}">${done ? ICON.check : ''}</button>
        <button type="button" class="tp-row__main" data-act="select">
          <span class="tp-row__title">${escapeHtml(t.title || t.jiraKey || '')}</span>
          <span class="tp-row__sub mono">${escapeHtml(sub)}</span>
        </button>
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
    if (detail) renderDetail();
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
    const raw = convertTicketLinks(el.title.value).trim();
    if (!raw) return;
    const key = (raw.match(KEY_RE) || [null])[0];
    let title = key ? raw.replace(key, '').replace(/\s{2,}/g, ' ').replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, '') : raw;
    if (!title && key && window.ZeitJira) { const issue = await window.ZeitJira.issue(key); if (issue && issue.summary) title = issue.summary; }
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
    try {
      const data = await Api.patch(`/api/tasks/${id}/done`, { done });
      if (done && state.selected === id) state.selected = data.next ? data.next.id : null;
      await load();
      if (!done) return;
      showToast(data.next ? `Erledigt. Nächste: ${dueText(data.next, todayISO())}.` : 'Aufgabe erledigt.', {
        label: 'Rückgängig', durationMs: 8000,
        onClick: async () => {
          try { await Api.patch(`/api/tasks/${id}/done`, { done: false }); if (data.next) await Api.del(`/api/tasks/${data.next.id}`); await load(); } catch (err) { showToast(err.message); }
        },
      });
    } catch (err) { showToast(err.message); }
  }

  async function removeTask(id) {
    try {
      await Api.del(`/api/tasks/${id}`);
      if (state.selected === id) state.selected = null;
      await load();
      showToast('Aufgabe gelöscht.', { label: 'Rückgängig', durationMs: 30000, onClick: async () => { try { await Api.post(`/api/tasks/${id}/restore`); await load(); } catch (err) { showToast(err.message); } } });
    } catch (err) { showToast(err.message); }
  }

  async function startTimer(t) {
    const pad2 = (n) => String(n).padStart(2, '0');
    const now = new Date();
    try {
      await Api.post('/api/timer', { work_date: todayISO(), start_time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`, description: t.title, jira_key: t.jiraKey || null, task_id: t.id });
      showToast(`Timer läuft für „${t.title || t.jiraKey}“.`, { label: 'Zu Heute', durationMs: 8000, onClick: () => { window.location.href = '/index.html'; } });
    } catch (err) {
      showToast(err.status === 409 ? 'Es läuft schon ein Timer – erst stoppen oder unterbrechen (Seite „Heute“).' : err.message);
    }
  }

  // --- Jira-Import -------------------------------------------------------------------------------------
  let importIssues = [];
  async function openImport() {
    el.importPanel.classList.remove('hidden');
    el.importPanel.textContent = 'Lade deine Tickets …';
    try {
      const all = await window.ZeitJira.myIssues();
      const have = new Set([...state.open, ...state.done].map((t) => (t.jiraKey || '').toUpperCase()));
      importIssues = all.filter((i) => !have.has(i.key.toUpperCase()));
      el.importPanel.innerHTML = importIssues.length ? `
        <div class="import__head">Offene Jira-Tickets von dir</div>
        ${importIssues.map((i, n) => `<label class="import__row"><input type="checkbox" data-n="${n}" checked />
          <span class="import__text"><span class="import__title">${escapeHtml(i.summary || i.key)}</span>
          <span class="import__sub mono">${escapeHtml(i.key)}${i.status ? ` · ${escapeHtml(i.status)}` : ''}${i.dueDate ? ` · fällig ${escapeHtml(i.dueDate)}` : ''}</span></span></label>`).join('')}
        <label class="import__due">Fällig am <select id="tpImportDue"><option value="jira">Jira-Termin (sonst ohne Datum)</option><option value="today">Heute</option><option value="none">Ohne Datum</option></select></label>
        <div class="import__actions"><button type="button" class="btn btn--ghost btn--sm" data-act="close">Schließen</button><span class="task-edit__spacer"></span><button type="button" class="btn btn--sm" data-act="apply">Übernehmen</button></div>`
        : '<div class="tasks__empty">Alle deine offenen Tickets sind schon in der Liste.</div><button type="button" class="btn btn--ghost btn--sm" data-act="close">Schließen</button>';
    } catch (err) {
      el.importPanel.innerHTML = `<div class="tasks__error">${escapeHtml(err.message)}</div><button type="button" class="btn btn--ghost btn--sm" data-act="close">Schließen</button>`;
    }
  }
  async function applyImport() {
    const mode = $('#tpImportDue').value;
    const picked = [...el.importPanel.querySelectorAll('input[data-n]:checked')].map((c) => importIssues[Number(c.dataset.n)]);
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
    else if (btn.dataset.act === 'start' && t) { clearTimeout(saveTimer); save(form).then(() => startTimer(findTask(id) || t)); }
  });

  el.importPanel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') el.importPanel.classList.add('hidden');
    else if (b.dataset.act === 'apply') applyImport();
  });
  if (window.ZeitJira) {
    window.ZeitJira.settings().then((s) => { if (s.configured) el.jira.classList.remove('hidden'); });
    el.jiraBtn.addEventListener('click', openImport);
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
    if (me.user.isApprentice) document.getElementById('weeklyNavLink').classList.remove('hidden');
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
