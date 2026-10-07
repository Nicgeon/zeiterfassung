'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  const state = { mode: 'week', anchor: todayISO(), data: null, sortMode: loadSortMode(), onlyOpen: false };

  const els = {
    userLabel: $('#userLabel'),
    adminNavLink: $('#adminNavLink'),
    weeklyNavLink: $('#weeklyNavLink'),
    logoutBtn: $('#logoutBtn'),
    rangeLabel: $('#rangeLabel'),
    rangeEyebrow: $('#rangeEyebrow'),
    entriesCount: $('#entriesCount'),
    rangeError: $('#rangeError'),
    prevBtn: $('#prevBtn'),
    nextBtn: $('#nextBtn'),
    todayBtn: $('#todayBtn'),
    weekModeBtn: $('#weekModeBtn'),
    monthModeBtn: $('#monthModeBtn'),
    statTotal: $('#statTotal'),
    statOpen: $('#statOpen'),
    statDays: $('#statDays'),
    statAvg: $('#statAvg'),
    dayBars: $('#dayBars'),
    jiraList: $('#jiraList'),
    entriesTableBody: $('#entriesTableBody'),
    copyJiraBtn: $('#copyJiraBtn'),
    csvBtn: $('#csvBtn'),
    sortSelect: $('#sortSelect'),
    onlyOpenToggle: $('#onlyOpenToggle'),
  };

  function parts(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return { y, m, d };
  }
  function iso(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function shiftDays(dateStr, days) {
    const { y, m, d } = parts(dateStr);
    const date = new Date(y, m - 1, d + days);
    return iso(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }
  function mondayOf(dateStr) {
    const { y, m, d } = parts(dateStr);
    const weekday = (new Date(y, m - 1, d).getDay() + 6) % 7;
    return shiftDays(dateStr, -weekday);
  }
  function currentRange() {
    if (state.mode === 'week') {
      const from = mondayOf(state.anchor);
      return { from, to: shiftDays(from, 6) };
    }
    const { y, m } = parts(state.anchor);
    return { from: iso(y, m, 1), to: iso(y, m, new Date(y, m, 0).getDate()) };
  }
  function shortDate(dateStr) {
    const { y, m, d } = parts(dateStr);
    return new Date(y, m - 1, d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function weekdayShort(dateStr) {
    const { y, m, d } = parts(dateStr);
    return new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday: 'short' });
  }

  function setMode(mode) {
    state.mode = mode;
    els.weekModeBtn.classList.toggle('is-active', mode === 'week');
    els.monthModeBtn.classList.toggle('is-active', mode === 'month');
    load();
  }

  function isoWeek(dateStr) {
    const { y, m, d } = parts(dateStr);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
    return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  }

  function renderLabel(from, to) {
    const monthName = (dateStr) => {
      const { y, m } = parts(dateStr);
      return new Date(y, m - 1, 1).toLocaleDateString('de-DE', { month: 'long' });
    };
    if (state.mode === 'week') {
      const a = parts(from);
      const b = parts(to);
      els.rangeEyebrow.textContent = `Kalenderwoche ${isoWeek(from)}`;
      els.rangeLabel.textContent = a.m === b.m
        ? `${a.d}. – ${b.d}. ${monthName(to)} ${b.y}`
        : `${a.d}. ${monthName(from)} – ${b.d}. ${monthName(to)} ${b.y}`;
    } else {
      const { y } = parts(from);
      els.rangeEyebrow.textContent = 'Monat';
      els.rangeLabel.textContent = `${monthName(from)} ${y}`;
    }
  }

  /** Eintraege der Tabelle: Filter und Sortierung wie gewaehlt (auch fuer den CSV-Export). */
  function visibleEntries() {
    const list = state.data ? state.data.entries : [];
    return sortEntries(state.onlyOpen ? list.filter((e) => !e.transferred) : list, state.sortMode);
  }

  function render() {
    const data = state.data;
    if (!data) return;

    const dayMap = new Map(data.days.map((d) => [d.date, d.minutes]));
    const recordedDays = data.days.length;
    els.statTotal.textContent = formatHM(data.totalMinutes);
    els.statOpen.textContent = formatHM(data.openMinutes);
    els.statDays.textContent = String(recordedDays);
    els.statAvg.textContent = recordedDays
      ? formatHM(Math.round(data.totalMinutes / recordedDays))
      : '–';

    // Balken pro Tag, inkl. Tage ohne Eintraege
    const maxMinutes = Math.max(60, ...data.days.map((d) => d.minutes));
    const rows = [];
    for (let date = data.from; date <= data.to; date = shiftDays(date, 1)) {
      const minutes = dayMap.get(date) || 0;
      const width = Math.round((minutes / maxMinutes) * 100);
      rows.push(`
        <div class="day-bar${minutes === 0 ? ' day-bar--empty' : ''}">
          <span class="day-bar__label mono">${weekdayShort(date)} ${shortDate(date).slice(0, 6)}</span>
          <span class="day-bar__track"><span class="day-bar__fill" data-width="${width}"></span></span>
          <span class="day-bar__value mono">${minutes ? formatHM(minutes) : '–'}</span>
        </div>`);
    }
    els.dayBars.innerHTML = rows.join('');
    // Breite ueber die CSSOM-Eigenschaft setzen; das ist von der strikten
    // Content-Security-Policy erlaubt, ein style=""-Attribut im HTML waere es nicht.
    els.dayBars.querySelectorAll('.day-bar__fill').forEach((el) => {
      el.style.width = `${el.dataset.width}%`;
    });

    els.jiraList.innerHTML = data.jira.length
      ? data.jira
          .map(
            (j) => `<div class="ticket-row">
              ${j.key === '(ohne Ticket)'
                ? '<span class="ticket-row__none">Ohne Ticket</span>'
                : `<span class="mono ticket-row__key">${escapeHtml(j.key)}</span>`}
              <span class="mono">${formatHM(j.minutes)}</span>
            </div>`
          )
          .join('')
      : '<div class="ticket-list--empty">Keine Einträge in diesem Zeitraum.</div>';
    els.copyJiraBtn.disabled = data.jira.length === 0;

    const rowsToShow = visibleEntries();
    els.csvBtn.disabled = rowsToShow.length === 0;
    els.entriesCount.textContent = data.entries.length ? `· ${rowsToShow.length}` : '';
    els.entriesTableBody.innerHTML = rowsToShow.length
      ? rowsToShow
          .map(
            (e) => `<tr${e.transferred ? ' class="row--transferred"' : ''}>
              <td class="mono">${shortDate(e.workDate)}</td>
              <td class="mono">${e.startTime}–${e.endTime}</td>
              <td class="mono">${formatDurationLong(e.durationMinutes)}</td>
              <td>${escapeHtml(e.description)}</td>
              <td>${e.jiraKey ? `<span class="jira-tag">${escapeHtml(e.jiraKey)}</span>` : ''}</td>
              <td>${e.transferred ? '<span class="badge badge--success">in Jira</span>' : '<span class="badge">offen</span>'}</td>
            </tr>`
          )
          .join('')
      : '<tr><td colspan="6" class="text-faint">Keine Einträge in diesem Zeitraum.</td></tr>';
  }

  async function load() {
    setFormError(els.rangeError, '');
    const { from, to } = currentRange();
    renderLabel(from, to);
    try {
      state.data = await Api.get(`/api/entries/range?from=${from}&to=${to}`);
      render();
    } catch (err) {
      setFormError(els.rangeError, err.message);
    }
  }

  async function init() {
    let me;
    try {
      me = await Api.get('/api/auth/me');
    } catch {
      return;
    }
    els.userLabel.textContent = me.user.displayName;
    if (me.user.role === 'admin') els.adminNavLink.classList.remove('hidden');
    if (me.user.isApprentice) els.weeklyNavLink.classList.remove('hidden');
    await Api.primeCsrf();
    setMode('week');
  }

  els.prevBtn.addEventListener('click', () => {
    if (state.mode === 'week') state.anchor = shiftDays(mondayOf(state.anchor), -7);
    else {
      const { y, m } = parts(state.anchor);
      state.anchor = iso(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, 1);
    }
    load();
  });
  els.nextBtn.addEventListener('click', () => {
    if (state.mode === 'week') state.anchor = shiftDays(mondayOf(state.anchor), 7);
    else {
      const { y, m } = parts(state.anchor);
      state.anchor = iso(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1);
    }
    load();
  });
  els.todayBtn.addEventListener('click', () => { state.anchor = todayISO(); load(); });
  els.weekModeBtn.addEventListener('click', () => setMode('week'));
  els.monthModeBtn.addEventListener('click', () => setMode('month'));

  els.copyJiraBtn.addEventListener('click', async () => {
    if (!state.data) return;
    const lines = state.data.jira.map(
      (j) => `${j.key === '(ohne Ticket)' ? 'Ohne Ticket' : j.key}: ${formatDurationJira(j.minutes)} (${j.minutes} Min)`
    );
    lines.push('', `Gesamt: ${formatDurationJira(state.data.totalMinutes)} (${state.data.totalMinutes} Min)`);
    const ok = await copyToClipboard(lines.join('\n'));
    showToast(ok ? 'Zusammenfassung kopiert.' : 'Kopieren fehlgeschlagen.');
  });

  els.sortSelect.value = state.sortMode;
  els.sortSelect.addEventListener('change', () => {
    state.sortMode = els.sortSelect.value;
    saveSortMode(state.sortMode);
    render();
  });
  els.onlyOpenToggle.addEventListener('change', () => {
    state.onlyOpen = els.onlyOpenToggle.checked;
    render();
  });

  els.csvBtn.addEventListener('click', () => {
    const rows = [['Datum', 'Start', 'Ende', 'Dauer (Min)', 'Beschreibung', 'Ticket', 'In Jira eingetragen']];
    for (const e of visibleEntries()) {
      rows.push([e.workDate, e.startTime, e.endTime, e.durationMinutes, e.description, e.jiraKey || '', e.transferred ? 'ja' : 'nein']);
    }
    const { from, to } = currentRange();
    downloadFile(`zeiterfassung_${from}_${to}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
    showToast('CSV gespeichert.');
  });

  els.logoutBtn.addEventListener('click', async () => {
    try { await Api.post('/api/auth/logout'); } catch { /* egal */ }
    window.location.href = '/login.html';
  });

  init();
})();
