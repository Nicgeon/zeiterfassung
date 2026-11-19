'use strict';

// Aufgabenliste: linke Spalte der Erfassungsseite, im Mini-Fenster als kompakte Karte.
// Abhaken passiert nur durch den Nutzer (nie automatisch beim Stoppen eines Timers).
// app.js ruft ZeitTasks.init({ startTimer, running }) auf; beim Zurückkehren ins Fenster lädt refresh() neu.
(function () {
  const $ = (sel) => document.querySelector(sel);
  const el = {
    tabs: document.querySelector('.tasks__tabs'),
    form: $('#taskAddForm'),
    title: $('#taskTitle'),
    due: $('#taskDue'),
    custom: $('#taskCustom'),
    dueDate: $('#taskDueDate'),
    dueTime: $('#taskDueTime'),
    error: $('#taskError'),
    list: $('#taskList'),
    doneToggle: $('#taskDoneToggle'),
    doneList: $('#taskDoneList'),
    jiraBar: $('#jiraBar'),
    jiraBtn: $('#jiraImportBtn'),
    jiraPanel: $('#jiraImport'),
  };
  if (!el.list) return;

  const isMini = document.documentElement.classList.contains('mini');
  const VIEW_KEY = 'zeit.taskView';
  const MINI_MAX = 3;
  const KEY_RE = /\b[A-Z][A-Z0-9_]+-\d+\b/;

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5"/></svg>',
  };

  const hooks = { startTimer: null, running: () => null };
  const state = {
    tasks: [],
    done: [],
    view: loadView(),
    editingId: null,
    doneOpen: false,
    loaded: false,
  };

  function loadView() {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (['today', 'soon', 'all'].includes(v)) return v;
    } catch { /* nur Komfort */ }
    return 'today';
  }

  // --- Datum -------------------------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');
  function addDaysISO(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d + days);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  function nextMonday(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const wd = (new Date(y, m - 1, d).getDay() + 6) % 7; // Mo = 0
    return addDaysISO(dateStr, 7 - wd);
  }
  function dayLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace(',', '');
  }

  function dueText(t, today) {
    if (!t.dueDate) return '';
    const time = t.dueTime ? ` ${t.dueTime}` : '';
    if (t.dueDate < today) return `überfällig seit ${dayLabel(t.dueDate)}`;
    if (t.dueDate === today) return t.dueTime ? `heute ${t.dueTime}` : 'heute';
    if (t.dueDate === addDaysISO(today, 1)) return `morgen${time}`;
    return `${dayLabel(t.dueDate)}${time}`;
  }

  function repeatText(r) {
    if (!r) return '';
    const names = { day: ['Tag', 'Tage'], week: ['Woche', 'Wochen'], month: ['Monat', 'Monate'] };
    return r.every === 1 ? { day: 'täglich', week: 'wöchentlich', month: 'monatlich' }[r.unit] : `alle ${r.every} ${names[r.unit][1]}`;
  }

  // --- Anzeige -----------------------------------------------------------------------------

  const rendered = new WeakMap();
  /** innerHTML nur ändern, wenn sich etwas geändert hat (sonst geht ein Klick beim Fokus-Abgleich verloren). */
  function setHtml(node, html) {
    if (rendered.get(node) === html) return;
    rendered.set(node, html);
    node.innerHTML = html;
  }

  function isRunning(t) {
    const timer = hooks.running();
    if (!timer) return false;
    return (timer.description || '') === (t.title || '') && (timer.jiraKey || '') === (t.jiraKey || '');
  }

  function rowHtml(t, today) {
    if (state.editingId === t.id) return editHtml(t);
    const overdue = t.dueDate && t.dueDate < today;
    const running = isRunning(t);
    const due = dueText(t, today);
    const sub = [t.jiraKey && t.title ? t.jiraKey : '', due, t.repeat ? repeatText(t.repeat) : ''].filter(Boolean).join(' · ');
    return `
      <div class="task${running ? ' task--running' : ''}${overdue ? ' task--overdue' : ''}${t.priority ? ' task--prio' : ''}" data-id="${t.id}">
        <button type="button" class="task__check" data-act="done" aria-label="Als erledigt abhaken" title="Erledigt"></button>
        <button type="button" class="task__main" data-act="edit" title="Bearbeiten">
          <span class="task__title">${escapeHtml(t.title || t.jiraKey || '')}</span>
          <span class="task__sub mono">${running ? 'läuft gerade' : escapeHtml(sub)}${t.repeat ? ` <span class="task__repeat">${ICON.repeat}</span>` : ''}</span>
        </button>
        ${t.priority ? '<span class="task__prio" title="Wichtig" aria-label="Wichtig">!</span>' : ''}
        <button type="button" class="task__play" data-act="start" aria-label="Timer starten" title="${running ? 'Timer läuft für diese Aufgabe' : 'Timer mit dieser Aufgabe starten'}"${running ? ' disabled' : ''}>${ICON.play}</button>
      </div>`;
  }

  function editHtml(t) {
    const r = t.repeat;
    const simple = !r || (r.every === 1 && r.mode === 'due');
    return `
      <form class="task-edit" data-id="${t.id}" autocomplete="off">
        <label class="task-edit__field">Titel
          <input type="text" name="title" maxlength="500" value="${escapeHtml(t.title)}" />
        </label>
        <div class="task-edit__row">
          <label class="task-edit__field">Ticket
            <input type="text" name="jira" class="mono" maxlength="500" value="${escapeHtml(t.jiraKey || '')}" placeholder="ITPKK-123" />
          </label>
          <label class="task-edit__field task-edit__field--check">
            <input type="checkbox" name="prio"${t.priority ? ' checked' : ''} /> Wichtig
          </label>
        </div>
        <div class="task-edit__row">
          <label class="task-edit__field">Fällig am
            <input type="date" name="date" value="${t.dueDate || ''}" />
          </label>
          <label class="task-edit__field">Uhrzeit
            <input type="time" name="time" value="${t.dueTime || ''}" />
          </label>
        </div>
        <label class="task-edit__field">Wiederholen
          <select name="repeat">
            <option value=""${!r ? ' selected' : ''}>Nie</option>
            <option value="day"${r && simple && r.unit === 'day' ? ' selected' : ''}>Täglich</option>
            <option value="week"${r && simple && r.unit === 'week' ? ' selected' : ''}>Wöchentlich</option>
            <option value="month"${r && simple && r.unit === 'month' ? ' selected' : ''}>Monatlich</option>
            ${r && !simple ? `<option value="keep" selected>${escapeHtml(repeatText(r))}${r.mode === 'done' ? ' (ab Erledigung)' : ''}</option>` : ''}
          </select>
        </label>
        <div class="task-edit__error" data-error></div>
        <div class="task-edit__actions">
          <button type="button" class="btn btn--ghost btn--sm task-edit__delete" data-act="delete">Löschen</button>
          <span class="task-edit__spacer"></span>
          <button type="button" class="btn btn--ghost btn--sm" data-act="cancel">Abbrechen</button>
          <button type="submit" class="btn btn--sm">Speichern</button>
        </div>
      </form>`;
  }

  function section(label, tone, items, today) {
    if (items.length === 0) return '';
    return `
      <div class="tasks__group${tone ? ` tasks__group--${tone}` : ''}">
        <div class="tasks__label">${label} <span class="tasks__count">${items.length}</span></div>
        ${items.map((t) => rowHtml(t, today)).join('')}
      </div>`;
  }

  function render() {
    const today = todayISO();
    const view = isMini ? 'today' : state.view;
    const open = state.tasks;
    const overdue = open.filter((t) => t.dueDate && t.dueDate < today);
    const todays = open.filter((t) => t.dueDate === today);
    const soon = open.filter((t) => t.dueDate && t.dueDate > today);
    const none = open.filter((t) => !t.dueDate);

    let html;
    if (isMini) {
      const rows = [...overdue, ...todays];
      const shown = rows.slice(0, MINI_MAX);
      html = shown.length ? shown.map((t) => rowHtml(t, today)).join('') : '<div class="tasks__empty">Nichts offen für heute.</div>';
      if (rows.length > MINI_MAX) html += `<div class="tasks__more-hint">+ ${rows.length - MINI_MAX} weitere im großen Fenster</div>`;
    } else if (view === 'today') {
      html = section('Überfällig', 'overdue', overdue, today) + section('Heute', '', todays, today);
      if (!html) html = `<div class="tasks__empty">Nichts offen für heute.${soon.length + none.length ? ' Unter „Demnächst“ und „Alle“ stehen weitere Aufgaben.' : ''}</div>`;
    } else if (view === 'soon') {
      html = section('Demnächst', '', soon, today);
      if (!html) html = '<div class="tasks__empty">Keine Aufgaben mit späterem Datum.</div>';
    } else {
      html = section('Überfällig', 'overdue', overdue, today) + section('Heute', '', todays, today) + section('Demnächst', '', soon, today) + section('Ohne Datum', '', none, today);
      if (!html) html = '<div class="tasks__empty">Noch keine Aufgaben. Oben eine eintragen und Enter drücken.</div>';
    }
    setHtml(el.list, html);

    if (el.tabs) {
      el.tabs.querySelectorAll('[data-view]').forEach((b) => {
        const on = b.dataset.view === view;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    if (el.doneToggle) {
      el.doneToggle.textContent = state.doneOpen ? 'Erledigte ausblenden' : 'Erledigte anzeigen';
      el.doneToggle.setAttribute('aria-expanded', String(state.doneOpen));
    }
    if (el.doneList) {
      el.doneList.classList.toggle('hidden', !state.doneOpen);
      setHtml(el.doneList, state.doneOpen
        ? (state.done.length
          ? state.done.map((t) => `
            <div class="task task--done" data-id="${t.id}">
              <button type="button" class="task__check is-on" data-act="reopen" aria-label="Wieder öffnen" title="Wieder öffnen">${ICON.check}</button>
              <span class="task__main"><span class="task__title">${escapeHtml(t.title || t.jiraKey || '')}</span>${t.jiraKey && t.title ? `<span class="task__sub mono">${escapeHtml(t.jiraKey)}</span>` : ''}</span>
            </div>`).join('')
          : '<div class="tasks__empty">Noch nichts erledigt.</div>')
        : '');
    }
  }

  // --- Laden und Ändern -------------------------------------------------------------------------

  function setError(message) {
    if (el.error) el.error.textContent = message || '';
  }

  async function load() {
    try {
      const data = await Api.get('/api/tasks');
      state.tasks = data.tasks;
      state.loaded = true;
      if (state.doneOpen) state.done = (await Api.get('/api/tasks?scope=done')).tasks;
      render();
    } catch (err) {
      if (!state.loaded) setError('Aufgaben konnten nicht geladen werden.');
    }
  }

  function addMonthsISO(dateStr, months) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const total = y * 12 + (m - 1) + months;
    const ny = Math.floor(total / 12);
    const nm = total % 12;
    const last = new Date(ny, nm + 1, 0).getDate(); // 31. Jan + 1 Monat = Monatsende
    return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
  }

  /** Datum zur Auswahl neben dem Eingabefeld (null = ohne Datum; undefined = "Datum wählen" ohne Eingabe). */
  function dueFromChoice(choice) {
    const today = todayISO();
    switch (choice) {
      case 'today': return today;
      case 'tomorrow': return addDaysISO(today, 1);
      case 'dayafter': return addDaysISO(today, 2);
      case 'monday': return nextMonday(today);
      case 'week': return addDaysISO(today, 7);
      case 'month': return addMonthsISO(today, 1);
      case 'custom': return el.dueDate.value || undefined;
      default: return null;
    }
  }

  function syncCustom() {
    const custom = el.due.value === 'custom';
    el.custom.classList.toggle('hidden', !custom);
    if (custom && !el.dueDate.value) el.dueDate.value = todayISO();
    if (custom) el.dueDate.focus();
  }

  async function addTask(text) {
    const raw = convertTicketLinks(text).trim();
    if (!raw) return;
    const key = (raw.match(KEY_RE) || [null])[0];
    // Steht nur ein Ticket da, bleibt es der Titel-Ersatz; sonst wird die Nummer aus dem Titel genommen
    const title = key ? raw.replace(key, '').replace(/\s{2,}/g, ' ').replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, '') : raw;
    setError('');
    // Nur eine Ticketnummer eingegeben: Titel aus Jira holen (falls eingerichtet), sonst bleibt die Nummer der Titel
    let finalTitle = title;
    if (!finalTitle && key && window.ZeitJira) {
      const issue = await window.ZeitJira.issue(key);
      if (issue && issue.summary) finalTitle = issue.summary;
    }
    const dueDate = dueFromChoice(el.due.value);
    if (dueDate === undefined) { setError('Bitte ein Datum wählen.'); el.dueDate.focus(); return; }
    const dueTime = el.due.value === 'custom' && el.dueTime.value ? el.dueTime.value : null;
    try {
      await Api.post('/api/tasks', { title: finalTitle, jira_key: key, due_date: dueDate, due_time: dueDate ? dueTime : null });
      el.title.value = '';
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function setDone(id, done) {
    try {
      const data = await Api.patch(`/api/tasks/${id}/done`, { done });
      await load();
      if (!done) return;
      const msg = data.next ? `Erledigt. Nächste Aufgabe: ${dueText(data.next, todayISO())}.` : 'Aufgabe erledigt.';
      showToast(msg, { label: 'Rückgängig', durationMs: 8000, onClick: async () => {
        try {
          // Rückgängig: die erledigte wieder öffnen und die automatisch angelegte nächste entfernen
          await Api.patch(`/api/tasks/${id}/done`, { done: false });
          if (data.next) await Api.del(`/api/tasks/${data.next.id}`);
          await load();
        } catch (err) { showToast(err.message); }
      } });
    } catch (err) {
      showToast(err.message);
    }
  }

  function taskById(id) {
    return state.tasks.find((t) => t.id === id);
  }

  async function saveEdit(form) {
    const id = Number(form.dataset.id);
    const f = new FormData(form);
    const errorBox = form.querySelector('[data-error]');
    const body = {
      title: String(f.get('title') || '').trim(),
      jira_key: String(f.get('jira') || '').trim() || null,
      due_date: f.get('date') || null,
      due_time: f.get('time') || null,
      priority: f.get('prio') ? 1 : 0,
    };
    const rep = f.get('repeat');
    if (rep === '') body.repeat = null;
    else if (rep !== 'keep') body.repeat = { every: 1, unit: rep, mode: 'due' };
    try {
      await Api.put(`/api/tasks/${id}`, body);
      state.editingId = null;
      await load();
    } catch (err) {
      if (errorBox) errorBox.textContent = err.message;
    }
  }

  async function removeTask(id) {
    try {
      await Api.del(`/api/tasks/${id}`);
      state.editingId = null;
      await load();
      showToast('Aufgabe gelöscht.', { label: 'Rückgängig', durationMs: 30000, onClick: async () => {
        try { await Api.post(`/api/tasks/${id}/restore`); await load(); } catch (err) { showToast(err.message); }
      } });
    } catch (err) {
      showToast(err.message);
    }
  }

  // --- Ereignisse -------------------------------------------------------------------------------

  el.due.addEventListener('change', syncCustom);
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    addTask(el.title.value);
  });

  el.list.addEventListener('submit', (e) => {
    const form = e.target.closest('.task-edit');
    if (!form) return;
    e.preventDefault();
    saveEdit(form);
  });

  el.list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const host = btn.closest('[data-id]');
    const id = host ? Number(host.dataset.id) : 0;
    const task = taskById(id);
    switch (btn.dataset.act) {
      case 'done': return setDone(id, true);
      case 'edit':
        state.editingId = state.editingId === id ? null : id;
        return render();
      case 'cancel':
        state.editingId = null;
        return render();
      case 'delete': return removeTask(id);
      case 'start':
        if (task && hooks.startTimer) hooks.startTimer(task).then(render);
        return undefined;
      default: return undefined;
    }
  });

  if (el.doneList) {
    el.doneList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="reopen"]');
      if (btn) setDone(Number(btn.closest('[data-id]').dataset.id), false);
    });
  }
  if (el.doneToggle) {
    el.doneToggle.addEventListener('click', async () => {
      state.doneOpen = !state.doneOpen;
      if (state.doneOpen) {
        try { state.done = (await Api.get('/api/tasks?scope=done')).tasks; } catch { state.done = []; }
      }
      render();
    });
  }
  if (el.tabs) {
    el.tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (!b) return;
      state.view = b.dataset.view;
      try { localStorage.setItem(VIEW_KEY, state.view); } catch { /* nur Komfort */ }
      render();
    });
  }

  // --- Eigene Jira-Tickets übernehmen (nur sichtbar, wenn Jira unter Konto eingerichtet ist) ----------------

  function importHtml(issues, dueMode) {
    const rows = issues.map((i, n) => `
      <label class="import__row">
        <input type="checkbox" data-n="${n}" checked />
        <span class="import__text">
          <span class="import__title">${escapeHtml(i.summary || i.key)}</span>
          <span class="import__sub mono">${escapeHtml(i.key)}${i.status ? ` · ${escapeHtml(i.status)}` : ''}${i.dueDate ? ` · fällig ${escapeHtml(i.dueDate)}` : ''}</span>
        </span>
      </label>`).join('');
    return `
      <div class="import__head">Offene Jira-Tickets von dir</div>
      ${rows}
      <label class="import__due">Fällig am
        <select id="jiraDueMode">
          <option value="jira"${dueMode === 'jira' ? ' selected' : ''}>Jira-Termin (sonst ohne Datum)</option>
          <option value="today"${dueMode === 'today' ? ' selected' : ''}>Heute</option>
          <option value="none"${dueMode === 'none' ? ' selected' : ''}>Ohne Datum</option>
        </select>
      </label>
      <div class="import__actions">
        <button type="button" class="btn btn--ghost btn--sm" data-act="import-close">Schließen</button>
        <span class="task-edit__spacer"></span>
        <button type="button" class="btn btn--sm" data-act="import-apply">Übernehmen</button>
      </div>`;
  }

  let importIssues = [];
  async function openImport() {
    el.jiraPanel.classList.remove('hidden');
    el.jiraPanel.textContent = 'Lade deine Tickets …';
    try {
      const all = await window.ZeitJira.myIssues();
      const have = new Set(state.tasks.map((t) => (t.jiraKey || '').toUpperCase()));
      importIssues = all.filter((i) => !have.has(i.key.toUpperCase()));
      el.jiraPanel.innerHTML = importIssues.length
        ? importHtml(importIssues, 'jira')
        : '<div class="tasks__empty">Alle deine offenen Tickets sind schon in der Liste (oder es gibt keine).</div><button type="button" class="btn btn--ghost btn--sm" data-act="import-close">Schließen</button>';
    } catch (err) {
      el.jiraPanel.innerHTML = `<div class="tasks__error">${escapeHtml(err.message)}</div><button type="button" class="btn btn--ghost btn--sm" data-act="import-close">Schließen</button>`;
    }
  }

  async function applyImport() {
    const mode = el.jiraPanel.querySelector('#jiraDueMode').value;
    const picked = [...el.jiraPanel.querySelectorAll('input[data-n]:checked')].map((c) => importIssues[Number(c.dataset.n)]);
    if (!picked.length) { el.jiraPanel.classList.add('hidden'); return; }
    let ok = 0;
    for (const i of picked) {
      const due = mode === 'today' ? todayISO() : mode === 'jira' ? i.dueDate : null;
      try {
        await Api.post('/api/tasks', { title: i.summary, jira_key: i.key, due_date: due || null, priority: /^(highest|high)$/i.test(i.priority) ? 1 : 0 });
        ok += 1;
      } catch (err) { setError(err.message); }
    }
    el.jiraPanel.classList.add('hidden');
    await load();
    showToast(`${ok} Aufgabe${ok === 1 ? '' : 'n'} aus Jira übernommen.`);
  }

  if (el.jiraBtn && window.ZeitJira && !isMini) {
    window.ZeitJira.settings().then((s) => { if (s.configured) el.jiraBar.classList.remove('hidden'); });
    el.jiraBtn.addEventListener('click', openImport);
    el.jiraPanel.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'import-close') el.jiraPanel.classList.add('hidden');
      else if (act.dataset.act === 'import-apply') applyImport();
    });
  }

  window.ZeitTasks = {
    init(h) {
      Object.assign(hooks, h || {});
      load();
    },
    refresh: load,
    render,
  };
})();
