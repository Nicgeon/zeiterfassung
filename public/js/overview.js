'use strict';

// Auswertung: Woche (ein Zeitstrahl je Tag), Monat (Kalender und Wochensummen) oder frei gewählter Zeitraum.
// Dazu die Summen (erfasst / in Jira / offen), "Wohin ging die Zeit?" je Ticket oder Aufgabe und alle Einträge mit
// Tagesfilter, Suche, "Nur offen", Sortierung und CSV.
// Breiten und Positionen werden per CSSOM gesetzt (data-l / data-w), weil die CSP style-Attribute im HTML verbietet.
(function () {
  const $ = (sel) => document.querySelector(sel);
  const STRIPS_MAX_DAYS = 14; // freier Zeitraum: bis zu zwei Wochen als Zeitstrahlen, länger als Wochenliste
  const DAY_FULL = 8 * 60; // Kalender: ein voller Balken = 8 Stunden
  const store = {
    get(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* egal */ } },
  };

  const state = {
    mode: store.get('zeit.report.mode', 'week'), // week | month | range
    group: store.get('zeit.report.group', 'ticket'), // ticket | task
    anchor: todayISO(),
    range: null, // {from, to} für "Zeitraum"
    data: null,
    tasks: null, // Map id -> Titel (erst geladen, wenn nach Aufgabe gruppiert wird)
    day: null, // Tagesfilter der Einträge
    onlyOpen: false,
    search: '',
    sortMode: loadSortMode(),
  };
  if (!['week', 'month', 'range'].includes(state.mode)) state.mode = 'week';

  const els = {
    userLabel: $('#userLabel'),
    adminNavLink: $('#adminNavLink'),
    logoutBtn: $('#logoutBtn'),
    rangeLabel: $('#rangeLabel'),
    rangeEyebrow: $('#rangeEyebrow'),
    rangeError: $('#rangeError'),
    rangeForm: $('#rangeForm'),
    rangeFrom: $('#rangeFrom'),
    rangeTo: $('#rangeTo'),
    prevBtn: $('#prevBtn'),
    nextBtn: $('#nextBtn'),
    todayBtn: $('#todayBtn'),
    statTotal: $('#statTotal'),
    statTotalSub: $('#statTotalSub'),
    statDone: $('#statDone'),
    statDoneSub: $('#statDoneSub'),
    statOpen: $('#statOpen'),
    statOpenSub: $('#statOpenSub'),
    postOpenBtn: $('#postOpenBtn'),
    mainTitle: $('#mainTitle'),
    mainHint: $('#mainHint'),
    mainView: $('#mainView'),
    gapLegend: $('#gapLegend'),
    weeksCard: $('#weeksCard'),
    weeksList: $('#weeksList'),
    groupList: $('#groupList'),
    copyJiraBtn: $('#copyJiraBtn'),
    entriesCount: $('#entriesCount'),
    dayFilter: $('#dayFilter'),
    searchInput: $('#searchInput'),
    sortSelect: $('#sortSelect'),
    csvBtn: $('#csvBtn'),
    entriesTableBody: $('#entriesTableBody'),
  };

  // --- Datum ---------------------------------------------------------------------------------------------

  const parts = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return { y, m, d }; };
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dateOf = (dateStr) => { const { y, m, d } = parts(dateStr); return new Date(y, m - 1, d); };
  function shiftDays(dateStr, days) {
    const date = dateOf(dateStr);
    date.setDate(date.getDate() + days);
    return iso(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }
  const weekdayIndex = (dateStr) => (dateOf(dateStr).getDay() + 6) % 7; // Mo = 0
  const mondayOf = (dateStr) => shiftDays(dateStr, -weekdayIndex(dateStr));
  const daysBetween = (a, b) => Math.round((dateOf(b) - dateOf(a)) / 86400000);
  const dayLabel = (dateStr) => `${dateOf(dateStr).toLocaleDateString('de-DE', { weekday: 'short' })} ${dateStr.slice(8, 10)}.${dateStr.slice(5, 7)}.`;
  const monthName = (dateStr) => dateOf(dateStr).toLocaleDateString('de-DE', { month: 'long' });
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  function isoWeek(dateStr) {
    const { y, m, d } = parts(dateStr);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    return Math.ceil(((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  }

  function currentRange() {
    if (state.mode === 'range' && state.range) return state.range;
    if (state.mode === 'month') {
      const { y, m } = parts(state.anchor);
      return { from: iso(y, m, 1), to: iso(y, m, new Date(y, m, 0).getDate()) };
    }
    const from = mondayOf(state.anchor);
    return { from, to: shiftDays(from, 6) };
  }

  function renderLabel(from, to) {
    const a = parts(from);
    const b = parts(to);
    if (state.mode === 'month') {
      els.rangeEyebrow.textContent = 'Monat';
      els.rangeLabel.textContent = `${monthName(from)} ${a.y}`;
      return;
    }
    els.rangeEyebrow.textContent = state.mode === 'week' ? `Kalenderwoche ${isoWeek(from)}` : `Zeitraum · ${daysBetween(from, to) + 1} Tage`;
    if (a.y !== b.y) els.rangeLabel.textContent = `${a.d}. ${monthName(from)} ${a.y} – ${b.d}. ${monthName(to)} ${b.y}`;
    else if (a.m !== b.m) els.rangeLabel.textContent = `${a.d}. ${monthName(from)} – ${b.d}. ${monthName(to)} ${b.y}`;
    else els.rangeLabel.textContent = a.d === b.d ? `${a.d}. ${monthName(to)} ${b.y}` : `${a.d}. – ${b.d}. ${monthName(to)} ${b.y}`;
  }

  // --- Hilfen für die Darstellung ------------------------------------------------------------------------

  /** Positionen und Breiten aus data-l / data-w (Prozent) übernehmen. */
  function applyGeometry(host) {
    host.querySelectorAll('[data-l]').forEach((el) => { el.style.left = `${el.dataset.l}%`; });
    host.querySelectorAll('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
  }
  const pct = (part, whole) => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0).toFixed(2);
  const sum = (list) => list.reduce((n, e) => n + e.durationMinutes, 0);
  const openOf = (list) => list.filter((e) => !e.transferred);

  function entriesByDay() {
    const map = new Map();
    for (const e of state.data.entries) {
      if (!map.has(e.workDate)) map.set(e.workDate, []);
      map.get(e.workDate).push(e);
    }
    return map;
  }

  // --- Zeitstrahlen je Tag (Woche, kurzer Zeitraum) ------------------------------------------------------

  function stripsHtml(from, to) {
    const showTimes = loadShowTimes();
    const byDay = entriesByDay();
    const today = todayISO();
    const nowMin = toMin(nowHHMM());
    const days = [];
    let first = Infinity;
    let last = -Infinity;
    for (let date = from; date <= to; date = shiftDays(date, 1)) {
      const list = byDay.get(date) || [];
      const blocks = [];
      let untimed = 0;
      for (const e of list) {
        const segs = e.segments || (showTimes ? [[e.startTime, e.endTime]] : null);
        if (!segs) { untimed += e.durationMinutes; continue; }
        for (const [s, en] of segs) blocks.push({ s: toMin(s), e: toMin(en), entry: e });
      }
      blocks.sort((x, y) => x.s - y.s);
      if (blocks.length) { first = Math.min(first, blocks[0].s); last = Math.max(last, ...blocks.map((b) => b.e)); }
      if (date === today) { first = Math.min(first, nowMin); last = Math.max(last, nowMin); }
      days.push({ date, list, blocks, untimed });
    }
    // gemeinsamer Bereich für alle Tage: volle Stunden, mindestens 8 Stunden
    let S = Number.isFinite(first) ? Math.floor(first / 60) * 60 : 7 * 60;
    let E = Number.isFinite(last) ? Math.ceil(last / 60) * 60 : 17 * 60;
    if (E - S < 8 * 60) E = Math.min(24 * 60, S + 8 * 60);
    if (E - S < 8 * 60) S = Math.max(0, E - 8 * 60);
    const span = E - S;
    const pos = (m) => pct(m - S, span);

    const rows = [];
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      const weekend = weekdayIndex(d.date) >= 5;
      if (weekend && !d.list.length) {
        // leeres Wochenende als eine gedämpfte Zeile
        if (weekdayIndex(d.date) === 5 && days[i + 1] && !days[i + 1].list.length) {
          rows.push(`<div class="day-strip day-strip--muted"><span class="day-strip__label mono">Sa – So</span><span class="day-strip__track"><span class="day-strip__empty">nichts erfasst</span></span><span></span><span class="day-strip__total mono">–</span></div>`);
          i++;
        } else if (!(weekdayIndex(d.date) === 6 && rows.length && days[i - 1] && !days[i - 1].list.length)) {
          rows.push(`<div class="day-strip day-strip--muted"><span class="day-strip__label mono">${dayLabel(d.date)}</span><span class="day-strip__track"><span class="day-strip__empty">nichts erfasst</span></span><span></span><span class="day-strip__total mono">–</span></div>`);
        }
        continue;
      }
      const total = sum(d.list);
      const inner = [];
      if (d.blocks.length) {
        const a = d.blocks[0].s;
        const b = Math.max(...d.blocks.map((x) => x.e), d.date === today ? nowMin : 0);
        inner.push(`<span class="day-strip__span" data-l="${pos(a)}" data-w="${pct(b - a, span)}"></span>`);
      }
      for (const b of d.blocks) {
        const e = b.entry;
        const title = `${e.description || e.jiraKey || ''} · ${minutesToHM(b.s)}–${minutesToHM(b.e)}${e.transferred ? ' · in Jira' : ''}`;
        inner.push(`<span class="day-strip__block day-strip__block--${e.transferred ? 'done' : 'open'}" data-l="${pos(b.s)}" data-w="${pct(b.e - b.s, span)}" title="${escapeHtml(title)}"></span>`);
      }
      if (d.date === today && nowMin >= S && nowMin <= E) inner.push(`<span class="day-strip__now" data-l="${pos(nowMin)}" aria-hidden="true"></span>`);
      if (!d.list.length) inner.push(`<span class="day-strip__empty">${d.date > today ? '' : 'nichts erfasst'}</span>`);
      const untimed = d.untimed ? `<span class="day-strip__untimed" title="Einträge ohne bekannte Uhrzeit">+${formatHM(d.untimed)} ohne Uhrzeit</span>` : '<span></span>';
      const cls = ['day-strip', d.date === today ? 'is-today' : '', state.day === d.date ? 'is-selected' : '', !d.list.length && d.date < today ? 'day-strip--missing' : ''].filter(Boolean).join(' ');
      rows.push(`<button type="button" class="${cls}" data-day="${d.date}" aria-pressed="${state.day === d.date}" title="${d.list.length ? 'Einträge dieses Tages zeigen' : ''}">
        <span class="day-strip__label mono">${dayLabel(d.date)}</span>
        <span class="day-strip__track">${inner.join('')}</span>
        ${untimed}
        <span class="day-strip__total mono">${total ? formatHM(total) : '–'}</span>
      </button>`);
    }
    const step = span > 12 * 60 ? 2 : 1;
    const hours = [];
    for (let h = S / 60; h <= E / 60; h += step) hours.push(`<span data-l="${pos(h * 60)}">${String(h).padStart(2, '0')}</span>`);
    const anyUntimed = days.some((d) => d.untimed);
    return `<div class="day-strips${anyUntimed ? ' day-strips--untimed' : ''}">${rows.join('')}
      <div class="day-strip day-strip--axis" aria-hidden="true"><span></span><span class="day-strip__axis mono">${hours.join('')}</span><span></span><span></span></div></div>`;
  }

  // --- Kalender (Monat) ----------------------------------------------------------------------------------

  function calendarHtml(from, to) {
    const byDay = entriesByDay();
    const today = todayISO();
    const head = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => `<span>${d}</span>`).join('');
    const weeks = [];
    for (let monday = mondayOf(from); monday <= to; monday = shiftDays(monday, 7)) {
      const cells = [`<span class="cal-kw mono">KW ${isoWeek(monday)}</span>`];
      for (let i = 0; i < 7; i++) {
        const date = shiftDays(monday, i);
        const num = Number(date.slice(8, 10));
        if (date < from || date > to) { cells.push(`<span class="cal-day cal-day--out"><span class="cal-day__num mono">${num}</span></span>`); continue; }
        const list = byDay.get(date) || [];
        const total = sum(list);
        const open = sum(openOf(list));
        const school = list.some((e) => e.school);
        const workday = i < 5;
        const missing = workday && !list.length && date < today;
        const tag = date === today ? 'Heute' : school ? 'Schule' : '';
        const cls = ['cal-day', date === today ? 'is-today' : '', missing ? 'cal-day--missing' : '', !list.length && !missing ? 'cal-day--empty' : ''].filter(Boolean).join(' ');
        cells.push(`<button type="button" class="${cls}" data-week="${date}" title="Woche mit dem ${num}. öffnen">
          <span class="cal-day__head"><span class="cal-day__num mono">${num}</span>${tag ? `<span class="cal-day__tag">${tag}</span>` : ''}</span>
          <strong class="cal-day__total mono">${total ? formatHM(total) : missing ? '–' : ''}</strong>
          <span class="cal-day__bar">${total ? `<span class="bar-done" data-w="${pct(total - open, DAY_FULL)}"></span><span class="bar-open" data-w="${pct(open, DAY_FULL)}"></span>` : ''}</span>
        </button>`);
      }
      weeks.push(cells.join(''));
    }
    return `<div class="calendar"><div class="calendar__head">${head}</div>${weeks.map((w) => `<div class="calendar__week">${w}</div>`).join('')}</div>`;
  }

  // --- Wochen (Monat: Seitenleiste, langer Zeitraum: Hauptbereich) ---------------------------------------

  function weeksHtml(from, to) {
    const rows = [];
    for (let monday = mondayOf(from); monday <= to; monday = shiftDays(monday, 7)) {
      const sunday = shiftDays(monday, 6);
      const list = state.data.entries.filter((e) => e.workDate >= monday && e.workDate <= sunday);
      rows.push({ monday, total: sum(list), open: sum(openOf(list)) });
    }
    const max = Math.max(40 * 60, ...rows.map((r) => r.total));
    return rows.map((r) => `<button type="button" class="week-row" data-week="${r.monday}" title="Woche öffnen">
        <span class="week-row__kw mono">KW ${isoWeek(r.monday)}</span>
        <span class="week-row__bar"><span class="bar-done" data-w="${pct(r.total - r.open, max)}"></span><span class="bar-open" data-w="${pct(r.open, max)}"></span></span>
        <strong class="week-row__total mono">${r.total ? formatHM(r.total) : '–'}</strong>
        <span class="week-row__open mono${r.open ? '' : ' is-zero'}">${r.open ? formatHM(r.open) : '–'}</span>
      </button>`).join('') + '<div class="week-row week-row--legend"><span></span><span></span><span>gesamt</span><span>offen</span></div>';
  }

  // --- Wohin ging die Zeit? ------------------------------------------------------------------------------

  function groups() {
    const map = new Map();
    for (const e of state.data.entries) {
      let key;
      let label;
      let sub;
      if (state.group === 'task') {
        const title = e.taskId && state.tasks ? state.tasks.get(e.taskId) : null;
        key = title ? `t${e.taskId}` : `d:${(e.description || e.jiraKey || '').trim().toLowerCase()}`;
        label = title || e.description || e.jiraKey || 'Ohne Text';
        sub = e.jiraKey || '';
      } else {
        key = e.jiraKey ? e.jiraKey.toUpperCase() : '';
        label = key || 'Ohne Ticket';
        sub = e.description || '';
      }
      if (!map.has(key)) map.set(key, { key, label, sub, total: 0, open: 0, ticket: state.group === 'ticket' ? key : '' });
      const g = map.get(key);
      g.total += e.durationMinutes;
      if (!e.transferred) g.open += e.durationMinutes;
      if (!g.sub && sub) g.sub = sub;
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }

  function renderGroups() {
    const list = groups();
    const max = Math.max(1, ...list.map((g) => g.total));
    els.groupList.innerHTML = list.length
      ? list.map((g) => {
        const byTicket = state.group === 'ticket';
        const head = byTicket
          ? `<span class="group-row__key${g.ticket ? ' mono' : ' group-row__key--plain'}">${escapeHtml(g.label)}</span><span class="group-row__sub">${g.ticket ? escapeHtml(g.sub) : ''}</span>`
          : `<span class="group-row__key group-row__key--plain">${escapeHtml(g.label)}</span><span class="group-row__sub mono">${escapeHtml(g.sub)}</span>`;
        const search = byTicket ? g.ticket : (g.sub || g.label);
        return `<button type="button" class="group-row" data-search="${escapeHtml(search)}" title="Einträge dazu zeigen">
          <span class="group-row__head">${head}<strong class="group-row__total mono">${formatHM(g.total)}</strong></span>
          <span class="group-row__bar"><span class="bar-done" data-w="${pct(g.total - g.open, max)}"></span><span class="bar-open" data-w="${pct(g.open, max)}"></span></span>
        </button>`;
      }).join('')
      : '<div class="ticket-list--empty">Keine Einträge in diesem Zeitraum.</div>';
    applyGeometry(els.groupList);
    els.copyJiraBtn.disabled = !state.data.jira.length;
  }

  // --- Einträge ------------------------------------------------------------------------------------------

  /** Einträge der Tabelle: Tag, "Nur offen", Suche und Sortierung wie gewählt (auch für den CSV-Export). */
  function visibleEntries() {
    const q = state.search.trim().toLowerCase();
    let list = state.data ? state.data.entries : [];
    if (state.day) list = list.filter((e) => e.workDate === state.day);
    if (state.onlyOpen) list = list.filter((e) => !e.transferred);
    if (q) list = list.filter((e) => `${e.description || ''} ${e.jiraKey || ''}`.toLowerCase().includes(q));
    return sortEntries(list, state.sortMode);
  }

  function renderEntries() {
    const all = state.data.entries;
    const rows = visibleEntries();
    const showTimes = loadShowTimes();
    els.csvBtn.disabled = rows.length === 0;
    els.entriesCount.textContent = all.length ? (rows.length === all.length ? `· ${all.length}` : `· ${rows.length} von ${all.length}`) : '';
    els.dayFilter.classList.toggle('hidden', !state.day);
    if (state.day) els.dayFilter.innerHTML = `${dayLabel(state.day)} <span aria-hidden="true">✕</span>`;
    const time = (e) => (e.segments ? e.segments.map(([a, b]) => `${a}–${b}`).join(', ') : showTimes ? `${e.startTime}–${e.endTime}` : '–');
    els.entriesTableBody.innerHTML = rows.length
      ? rows.map((e) => `<tr${e.transferred ? ' class="row--transferred"' : ''}>
          <td class="mono">${dayLabel(e.workDate)}</td>
          <td class="mono col-time">${time(e)}</td>
          <td class="mono">${formatHM(e.durationMinutes)}</td>
          <td>${e.description ? escapeHtml(e.description) : '<span class="text-faint">–</span>'}</td>
          <td>${e.jiraKey ? `<span class="jira-tag" data-jira-open="${escapeHtml(e.jiraKey)}">${escapeHtml(e.jiraKey)}</span>` : ''}</td>
          <td class="jira-cell">${e.transferred ? '<span class="state-dot state-dot--done">in Jira</span>' : `<span class="state-dot state-dot--open">offen</span><button type="button" class="btn btn--ghost btn--sm jira-write-only" data-send="${e.id}" title="Als internen Kommentar nach Jira schreiben">Senden</button>`}</td>
        </tr>`).join('')
      : `<tr><td colspan="6" class="text-faint">${all.length ? 'Keine passenden Einträge.' : 'Keine Einträge in diesem Zeitraum.'}</td></tr>`;
  }

  // --- Gesamt --------------------------------------------------------------------------------------------

  function render() {
    const data = state.data;
    if (!data) return;
    const { from, to } = currentRange();
    const days = new Set(data.entries.map((e) => e.workDate)).size;
    const open = openOf(data.entries);
    els.statTotal.textContent = formatHM(data.totalMinutes);
    els.statTotalSub.textContent = days ? `${days} ${days === 1 ? 'Tag' : 'Tage'} · Ø ${formatHM(Math.round(data.totalMinutes / days))}` : '';
    els.statDone.textContent = formatHM(data.totalMinutes - data.openMinutes);
    els.statDoneSub.textContent = data.totalMinutes ? `${Math.round(((data.totalMinutes - data.openMinutes) / data.totalMinutes) * 100)} %` : '';
    els.statOpen.textContent = formatHM(data.openMinutes);
    els.statOpenSub.textContent = open.length ? `${open.length} ${open.length === 1 ? 'Eintrag' : 'Einträge'}` : 'alles eingetragen';
    els.postOpenBtn.disabled = !open.length;

    const span = daysBetween(from, to) + 1;
    let view = 'strips';
    if (state.mode === 'month') view = 'calendar';
    else if (state.mode === 'range' && span > STRIPS_MAX_DAYS) view = 'weeks';
    els.mainTitle.textContent = { strips: state.mode === 'week' ? 'Woche' : 'Tage', calendar: 'Kalender', weeks: 'Wochen' }[view];
    els.mainHint.textContent = { strips: 'Tag anklicken: Einträge unten filtern', calendar: 'Tag anklicken: Woche öffnen', weeks: 'Woche anklicken: Woche öffnen' }[view];
    els.gapLegend.classList.toggle('hidden', view !== 'strips');
    els.mainView.className = `report-view report-view--${view}`;
    els.mainView.innerHTML = view === 'strips' ? stripsHtml(from, to) : view === 'calendar' ? calendarHtml(from, to) : `<div class="weeks-list">${weeksHtml(from, to)}</div>`;
    applyGeometry(els.mainView);

    els.weeksCard.classList.toggle('hidden', view !== 'calendar');
    if (view === 'calendar') {
      els.weeksList.innerHTML = weeksHtml(from, to);
      applyGeometry(els.weeksList);
    }
    renderGroups();
    renderEntries();
  }

  async function load() {
    setFormError(els.rangeError, '');
    els.rangeForm.classList.toggle('hidden', state.mode !== 'range');
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === state.mode));
    const { from, to } = currentRange();
    renderLabel(from, to);
    try {
      const [data] = await Promise.all([Api.get(`/api/entries/range?from=${from}&to=${to}`), state.group === 'task' ? loadTasks() : null]);
      state.data = data;
      if (state.day && (state.day < from || state.day > to)) state.day = null;
      render();
    } catch (err) {
      setFormError(els.rangeError, err.message);
    }
  }

  async function loadTasks() {
    if (state.tasks) return;
    try {
      const { tasks } = await Api.get('/api/tasks?scope=all');
      state.tasks = new Map(tasks.map((t) => [t.id, t.title || t.jiraKey || '']));
    } catch {
      state.tasks = new Map();
    }
  }

  function setMode(mode) {
    if (mode === 'range' && !state.range) {
      const r = currentRange();
      state.range = { from: r.from, to: r.to };
    }
    state.mode = mode;
    state.day = null;
    store.set('zeit.report.mode', mode);
    if (mode === 'range') { els.rangeFrom.value = state.range.from; els.rangeTo.value = state.range.to; }
    load();
  }

  function openWeek(date, filterDay) {
    state.mode = 'week';
    store.set('zeit.report.mode', 'week');
    state.anchor = date;
    state.day = filterDay ? date : null;
    load();
  }

  function shift(direction) {
    if (state.mode === 'week') state.anchor = shiftDays(mondayOf(state.anchor), 7 * direction);
    else if (state.mode === 'month') {
      const { y, m } = parts(state.anchor);
      const date = new Date(y, m - 1 + direction, 1);
      state.anchor = iso(date.getFullYear(), date.getMonth() + 1, 1);
    } else {
      const span = daysBetween(state.range.from, state.range.to) + 1;
      state.range = { from: shiftDays(state.range.from, span * direction), to: shiftDays(state.range.to, span * direction) };
      els.rangeFrom.value = state.range.from;
      els.rangeTo.value = state.range.to;
    }
    state.day = null;
    load();
  }

  // --- Ereignisse ----------------------------------------------------------------------------------------

  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  els.prevBtn.addEventListener('click', () => shift(-1));
  els.nextBtn.addEventListener('click', () => shift(1));
  els.todayBtn.addEventListener('click', () => {
    state.anchor = todayISO();
    state.day = null;
    if (state.mode === 'range') { state.mode = 'week'; store.set('zeit.report.mode', 'week'); }
    load();
  });
  els.rangeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const from = els.rangeFrom.value;
    const to = els.rangeTo.value;
    if (!from || !to) return;
    if (from > to) return setFormError(els.rangeError, '„Von“ muss vor „Bis“ liegen.');
    if (daysBetween(from, to) > 400) return setFormError(els.rangeError, 'Der Zeitraum darf höchstens 400 Tage umfassen.');
    state.range = { from, to };
    state.day = null;
    load();
  });

  els.mainView.addEventListener('click', (e) => {
    const strip = e.target.closest('[data-day]');
    if (strip) {
      state.day = state.day === strip.dataset.day ? null : strip.dataset.day;
      render();
      return;
    }
    const week = e.target.closest('[data-week]');
    if (week) openWeek(week.dataset.week, state.mode === 'month');
  });
  els.weeksList.addEventListener('click', (e) => {
    const week = e.target.closest('[data-week]');
    if (week) openWeek(week.dataset.week, false);
  });
  els.dayFilter.addEventListener('click', () => { state.day = null; render(); });

  document.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', async () => {
    state.group = b.dataset.group;
    store.set('zeit.report.group', state.group);
    document.querySelectorAll('[data-group]').forEach((x) => x.classList.toggle('is-active', x === b));
    if (state.group === 'task') await loadTasks();
    if (state.data) renderGroups();
  }));
  document.querySelectorAll('[data-group]').forEach((x) => x.classList.toggle('is-active', x.dataset.group === state.group));
  els.groupList.addEventListener('click', (e) => {
    if (e.target.closest('[data-jira-open]')) return;
    const row = e.target.closest('[data-search]');
    if (!row) return;
    state.search = state.search === row.dataset.search ? '' : row.dataset.search;
    els.searchInput.value = state.search;
    renderEntries();
  });

  els.searchInput.addEventListener('input', () => { state.search = els.searchInput.value; renderEntries(); });
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    state.onlyOpen = b.dataset.filter === 'open';
    document.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('is-active', x === b));
    renderEntries();
  }));
  els.sortSelect.value = state.sortMode;
  els.sortSelect.addEventListener('change', () => {
    state.sortMode = els.sortSelect.value;
    saveSortMode(state.sortMode);
    renderEntries();
  });

  els.entriesTableBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-send]');
    if (!btn) return;
    const entry = state.data.entries.find((x) => x.id === Number(btn.dataset.send));
    if (entry && (await ZeitJira.postEntries([entry]))) load();
  });
  els.postOpenBtn.addEventListener('click', async () => {
    const open = sortEntries(openOf(state.data ? state.data.entries : []), 'time-asc');
    if (await ZeitJira.postEntries(open)) load();
  });

  els.copyJiraBtn.addEventListener('click', async () => {
    if (!state.data) return;
    const lines = state.data.jira.map(
      (j) => `${j.key === '(ohne Ticket)' ? 'Ohne Ticket' : j.key}: ${formatDurationJira(j.minutes)} (${j.minutes} Min)`
    );
    lines.push('', `Gesamt: ${formatDurationJira(state.data.totalMinutes)} (${state.data.totalMinutes} Min)`);
    const ok = await copyToClipboard(lines.join('\n'));
    showToast(ok ? 'Zusammenfassung kopiert.' : 'Kopieren fehlgeschlagen.');
  });

  els.csvBtn.addEventListener('click', () => {
    const withTimes = loadShowTimes();
    const rows = [['Datum', ...(withTimes ? ['Start', 'Ende'] : []), 'Dauer (Min)', 'Beschreibung', 'Ticket', 'In Jira eingetragen']];
    for (const e of visibleEntries()) {
      rows.push([e.workDate, ...(withTimes ? [e.startTime, e.endTime] : []), e.durationMinutes, e.description, e.jiraKey || '', e.transferred ? 'ja' : 'nein']);
    }
    const { from, to } = currentRange();
    downloadFile(`zeiterfassung_${from}_${to}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
    showToast('CSV gespeichert.');
  });

  els.logoutBtn.addEventListener('click', async () => {
    try { await Api.post('/api/auth/logout'); } catch { /* egal */ }
    window.location.href = '/login.html';
  });

  async function init() {
    let me;
    try {
      me = await Api.get('/api/auth/me');
    } catch {
      return;
    }
    els.userLabel.textContent = me.user.displayName;
    if (me.user.role === 'admin') els.adminNavLink.classList.remove('hidden');
    await Api.primeCsrf();
    // Sprung aus anderen Seiten: /uebersicht.html#tag-2026-11-20 zeigt die Woche mit diesem Tag
    const m = /^#tag-(\d{4}-\d{2}-\d{2})$/.exec(window.location.hash);
    if (m) { openWeek(m[1], true); return; }
    if (state.mode === 'range') state.mode = 'week'; // ein freier Zeitraum wird nicht gemerkt
    load();
  }

  init();
})();
