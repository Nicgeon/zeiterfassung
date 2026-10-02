'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  const state = { weekStart: null, days: [] };

  const els = {
    userLabel: $('#userLabel'),
    adminNavLink: $('#adminNavLink'),
    logoutBtn: $('#logoutBtn'),
    weekLabel: $('#weekLabel'),
    prevWeekBtn: $('#prevWeekBtn'),
    nextWeekBtn: $('#nextWeekBtn'),
    thisWeekBtn: $('#thisWeekBtn'),
    formatSelect: $('#formatSelect'),
    bulletSelect: $('#bulletSelect'),
    mergeDuplicates: $('#mergeDuplicates'),
    includeJira: $('#includeJira'),
    reportError: $('#reportError'),
    reportPreview: $('#reportPreview'),
    copyBtn: $('#copyBtn'),
    downloadBtn: $('#downloadBtn'),
  };

  function shiftDate(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function weekdayName(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday: 'long' });
  }

  function shortDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function taskLines(tasks) {
    const withJira = els.includeJira.checked;
    let lines = tasks.map((t) => (withJira && t.jiraKey ? `${t.description} (${t.jiraKey})` : t.description));
    if (els.mergeDuplicates.checked) lines = [...new Set(lines)];
    return lines;
  }

  function buildReport() {
    const bullet = els.bulletSelect.value;
    const grouped = els.formatSelect.value === 'grouped';
    const out = [];

    if (grouped) {
      for (const day of state.days) {
        const lines = taskLines(day.tasks);
        if (lines.length === 0) continue; // Tage ohne Eintraege weglassen
        out.push(`${weekdayName(day.date)}, ${shortDate(day.date)}`);
        for (const line of lines) out.push(`${bullet}${line}`);
        out.push('');
      }
      while (out.length && out[out.length - 1] === '') out.pop();
    } else {
      const all = state.days.flatMap((day) => taskLines(day.tasks));
      const lines = els.mergeDuplicates.checked ? [...new Set(all)] : all;
      for (const line of lines) out.push(`${bullet}${line}`);
    }

    return out.join('\n');
  }

  function render() {
    const start = state.weekStart;
    const end = shiftDate(start, 6);
    els.weekLabel.textContent = `${shortDate(start)} – ${shortDate(end)}`;

    const text = buildReport();
    const empty = text.trim() === '';
    els.reportPreview.textContent = empty ? 'Keine Einträge in dieser Woche.' : text;
    els.reportPreview.classList.toggle('report-preview--empty', empty);
    els.copyBtn.disabled = empty;
    els.downloadBtn.disabled = empty;
  }

  async function loadWeek(dateStr) {
    setFormError(els.reportError, '');
    try {
      const data = await Api.get(`/api/entries/week?start=${dateStr}`);
      state.weekStart = data.start;
      state.days = data.days;
      render();
    } catch (err) {
      setFormError(els.reportError, err.message);
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
    await Api.primeCsrf();
    await loadWeek(todayISO());
  }

  for (const el of [els.formatSelect, els.bulletSelect, els.mergeDuplicates, els.includeJira]) {
    el.addEventListener('change', render);
  }

  els.prevWeekBtn.addEventListener('click', () => loadWeek(shiftDate(state.weekStart, -7)));
  els.nextWeekBtn.addEventListener('click', () => loadWeek(shiftDate(state.weekStart, 7)));
  els.thisWeekBtn.addEventListener('click', () => loadWeek(todayISO()));

  els.copyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(buildReport());
    showToast(ok ? 'Wochenbericht kopiert.' : 'Kopieren fehlgeschlagen.');
  });

  els.downloadBtn.addEventListener('click', () => {
    const blob = new Blob([buildReport()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Wochenbericht_${state.weekStart}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  els.logoutBtn.addEventListener('click', async () => {
    try { await Api.post('/api/auth/logout'); } catch { /* egal */ }
    window.location.href = '/login.html';
  });

  init();
})();
