'use strict';

// Kompakte Aufgabenliste auf "Heute" ("Als Nächstes") und im Mini-Fenster: überfällige und heutige Aufgaben,
// Anlegen über die Eingabezeile, abhaken, Timer starten. Die volle Liste mit allen Ansichten steht auf der Seite
// "Aufgaben" (aufgaben.js). Abgehakt wird nur von Hand.
// heute/start.js ruft ZeitTasks.init({ startTimer, running }) auf; beim Zurückkehren ins Fenster lädt refresh() neu.
(function () {
  const $ = (sel) => document.querySelector(sel);
  const A = window.AufgabenHilfe;
  const el = {
    form: $('#taskAddForm'),
    title: $('#taskTitle'),
    due: $('#taskDue'),
    custom: $('#taskCustom'),
    dueDate: $('#taskDueDate'),
    dueTime: $('#taskDueTime'),
    error: $('#taskError'),
    list: $('#taskList'),
  };
  if (!el.list) return;

  const isMini = document.documentElement.classList.contains('mini');
  const MAX_ROWS = isMini ? 3 : 6;
  const setHtml = A.htmlSetter();
  const hooks = { startTimer: null, running: () => null };
  const state = { tasks: [], editingId: null, loaded: false };

  // --- Anzeige ---------------------------------------------------------------------------------------------

  /** Läuft der Timer gerade für diese Aufgabe? (verknüpft, sonst gleicher Text und gleiches Ticket) */
  function isRunning(task) {
    const timer = hooks.running();
    if (!timer) return false;
    if (timer.taskId) return timer.taskId === task.id;
    return (timer.description || '') === (task.title || '') && (timer.jiraKey || '') === (task.jiraKey || '');
  }

  function rowHtml(task, today) {
    if (state.editingId === task.id) return editHtml(task);
    const overdue = task.dueDate && task.dueDate < today;
    const running = isRunning(task);
    const sub = task.jiraDone ? 'in Jira erledigt – abhaken?'
      : [task.jiraKey && task.title ? task.jiraKey : '', A.dueText(task, today), A.repeatText(task.repeat)].filter(Boolean).join(' · ');
    return `
      <div class="task${running ? ' task--running' : ''}${task.jiraDone ? ' task--jira-done' : ''}${overdue ? ' task--overdue' : ''}${task.priority ? ' task--prio' : ''}" data-id="${task.id}">
        <button type="button" class="task__check" data-act="done" aria-label="Als erledigt abhaken" title="Erledigt"></button>
        <button type="button" class="task__main" data-act="edit" title="${isMini ? 'Bearbeiten' : 'Auf der Aufgaben-Seite öffnen'}">
          <span class="task__title">${escapeHtml(task.title || task.jiraKey || '')}</span>
          <span class="task__sub mono">${running ? 'läuft gerade' : escapeHtml(sub)}${task.repeat ? ` <span class="task__repeat">${A.ICON.repeat}</span>` : ''}</span>
        </button>
        ${task.priority ? '<span class="task__prio" title="Wichtig" aria-label="Wichtig">!</span>' : ''}
        ${task.jiraKey ? `<button type="button" class="task__jira" data-jira-open="${escapeHtml(task.jiraKey)}" aria-label="Ticket ${escapeHtml(task.jiraKey)} in Jira öffnen" title="In Jira öffnen">${A.ICON.external}</button>` : ''}
        <button type="button" class="task__play" data-act="start" aria-label="Timer starten" title="${running ? 'Timer läuft für diese Aufgabe' : 'Timer mit dieser Aufgabe starten'}"${running ? ' disabled' : ''}>${A.ICON.play}</button>
      </div>`;
  }

  /** Bearbeiten direkt in der Liste (nur im Mini-Fenster; im großen Fenster gibt es die Aufgaben-Seite). */
  function editHtml(task) {
    const r = task.repeat;
    const simple = !r || (r.every === 1 && r.mode === 'due');
    const opt = (value, label) => `<option value="${value}"${r && simple && r.unit === value ? ' selected' : ''}>${label}</option>`;
    return `
      <form class="task-edit" data-id="${task.id}" autocomplete="off">
        <label class="task-edit__field">Titel <input type="text" name="title" maxlength="500" value="${escapeHtml(task.title)}" /></label>
        <div class="task-edit__row">
          <label class="task-edit__field">Ticket <input type="text" name="jira" class="mono" maxlength="500" value="${escapeHtml(task.jiraKey || '')}" placeholder="ITPKK-123" /></label>
          <label class="task-edit__field task-edit__field--check"><input type="checkbox" name="prio"${task.priority ? ' checked' : ''} /> Wichtig</label>
        </div>
        <div class="task-edit__row">
          <label class="task-edit__field">Fällig am <input type="date" name="date" value="${task.dueDate || ''}" /></label>
          <label class="task-edit__field">Uhrzeit <input type="time" name="time" value="${task.dueTime || ''}" /></label>
        </div>
        <label class="task-edit__field">Wiederholen
          <select name="repeat">
            <option value=""${!r ? ' selected' : ''}>Nie</option>
            ${opt('day', 'Täglich')}${opt('week', 'Wöchentlich')}${opt('month', 'Monatlich')}
            ${r && !simple ? `<option value="keep" selected>${escapeHtml(A.repeatText(r))}${r.mode === 'done' ? ' (ab Erledigung)' : ''}</option>` : ''}
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

  function render() {
    const today = todayISO();
    const due = state.tasks.filter((t) => t.dueDate && t.dueDate <= today); // überfällig + heute
    let html = due.slice(0, MAX_ROWS).map((t) => rowHtml(t, today)).join('') || '<div class="tasks__empty">Nichts offen für heute.</div>';
    if (due.length > MAX_ROWS) {
      const more = due.length - MAX_ROWS;
      html += isMini
        ? `<div class="tasks__more-hint">+ ${more} weitere im großen Fenster</div>`
        : `<a class="tasks__more-hint" href="/aufgaben.html">+ ${more} weitere unter „Aufgaben“</a>`;
    }
    setHtml(el.list, html);
  }

  // --- Laden und Ändern ----------------------------------------------------------------------------------

  const setError = (message) => { if (el.error) el.error.textContent = message || ''; };

  async function load() {
    try {
      state.tasks = (await Api.get('/api/tasks')).tasks;
      state.loaded = true;
      render();
    } catch {
      if (!state.loaded) setError('Aufgaben konnten nicht geladen werden.');
    }
  }

  async function addTask() {
    const input = await A.parseQuickInput(el.title.value);
    if (!input) return;
    const dueDate = A.dateForChoice(el.due.value, el.dueDate.value);
    if (dueDate === undefined) { setError('Bitte ein Datum wählen.'); el.dueDate.focus(); return; }
    const dueTime = el.due.value === 'custom' && el.dueTime.value ? el.dueTime.value : null;
    setError('');
    try {
      await Api.post('/api/tasks', { title: input.title, jira_key: input.key, due_date: dueDate, due_time: dueDate ? dueTime : null });
      el.title.value = '';
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveEdit(form) {
    const f = new FormData(form);
    const body = {
      title: String(f.get('title') || '').trim(),
      jira_key: String(f.get('jira') || '').trim() || null,
      due_date: f.get('date') || null,
      due_time: f.get('time') || null,
      priority: f.get('prio') ? 1 : 0,
    };
    const repeat = f.get('repeat');
    if (repeat === '') body.repeat = null;
    else if (repeat !== 'keep') body.repeat = { every: 1, unit: repeat, mode: 'due' };
    try {
      await Api.put(`/api/tasks/${Number(form.dataset.id)}`, body);
      state.editingId = null;
      await load();
    } catch (err) {
      form.querySelector('[data-error]').textContent = err.message;
    }
  }

  // --- Ereignisse ----------------------------------------------------------------------------------------

  el.due.addEventListener('change', () => {
    const custom = el.due.value === 'custom';
    el.custom.classList.toggle('hidden', !custom);
    if (custom && !el.dueDate.value) el.dueDate.value = todayISO();
    if (custom) el.dueDate.focus();
  });
  el.form.addEventListener('submit', (e) => { e.preventDefault(); addTask(); });

  el.list.addEventListener('submit', (e) => {
    const form = e.target.closest('.task-edit');
    if (!form) return;
    e.preventDefault();
    saveEdit(form);
  });

  el.list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('[data-id]').dataset.id);
    const task = state.tasks.find((t) => t.id === id);
    switch (btn.dataset.act) {
      case 'done':
        A.setDone(id, true, load);
        break;
      case 'edit':
        // Im großen Fenster öffnet ein Klick die Aufgabe auf der Aufgaben-Seite (mit Notiz, erfasster Zeit usw.)
        if (!isMini) { window.location.href = `/aufgaben.html#aufgabe-${id}`; return; }
        state.editingId = state.editingId === id ? null : id;
        render();
        break;
      case 'cancel':
        state.editingId = null;
        render();
        break;
      case 'delete':
        state.editingId = null;
        A.remove(id, load);
        break;
      case 'start':
        if (task && hooks.startTimer) hooks.startTimer(task).then(render);
        break;
      default:
    }
  });

  window.ZeitTasks = {
    init(h) {
      Object.assign(hooks, h || {});
      load();
    },
    refresh: load,
    render,
  };
})();
