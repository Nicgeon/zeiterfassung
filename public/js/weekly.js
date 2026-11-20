'use strict';

// Berichte: Wochenbericht (nur die Texte der Woche, ohne Zeiten) mit Darstellungsoptionen, dazu die Woche auf einen
// Blick. Der Berichtsheft-Text (berichtsheft.js) hört auf "weekchange" und arbeitet mit derselben Woche.
(function () {
  const $ = (sel) => document.querySelector(sel);

  const state = { weekStart: null, days: [], opts: loadOpts() };

  const els = {
    userLabel: $('#userLabel'),
    adminNavLink: $('#adminNavLink'),
    logoutBtn: $('#logoutBtn'),
    weekLabel: $('#weekLabel'),
    weekEyebrow: $('#weekEyebrow'),
    weekDays: $('#weekDays'),
    prevWeekBtn: $('#prevWeekBtn'),
    nextWeekBtn: $('#nextWeekBtn'),
    thisWeekBtn: $('#thisWeekBtn'),
    reportError: $('#reportError'),
    reportPreview: $('#reportPreview'),
    copyBtn: $('#copyBtn'),
    downloadBtn: $('#downloadBtn'),
    bhCard: $('#bhCard'),
    grid: $('#reportsGrid'),
  };

  /** Darstellung des Wochenberichts (wird im Browser gemerkt). */
  function loadOpts() {
    const fallback = { format: 'grouped', bullet: '- ', merge: true, jira: false };
    try { return { ...fallback, ...JSON.parse(localStorage.getItem('zeit.weekly.opts') || '{}') }; } catch { return fallback; }
  }
  function saveOpts() {
    try { localStorage.setItem('zeit.weekly.opts', JSON.stringify(state.opts)); } catch { /* egal */ }
  }
  function renderOpts() {
    document.querySelectorAll('[data-opt]').forEach((b) => b.classList.toggle('is-active', state.opts[b.dataset.opt] === b.dataset.value));
    document.querySelectorAll('[data-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(!!state.opts[b.dataset.toggle])));
  }

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

  function isoWeek(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    return Math.ceil(((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  }

  function taskLines(tasks) {
    const withJira = state.opts.jira;
    // Eintraege ohne Text erscheinen nur, wenn Ticketnummern ausgegeben werden
    let lines = tasks
      .map((t) => (t.description ? (withJira && t.jiraKey ? `${t.description} (${t.jiraKey})` : t.description) : withJira ? t.jiraKey || '' : ''))
      .filter(Boolean);
    if (state.opts.merge) lines = [...new Set(lines)];
    return lines;
  }

  function buildReport() {
    const bullet = state.opts.bullet;
    const grouped = state.opts.format === 'grouped';
    const out = [];

    if (grouped) {
      for (const day of state.days) {
        const lines = taskLines(day.tasks);
        if (lines.length === 0) continue; // Tage ohne Eintraege weglassen
        out.push(`${weekdayName(day.date)}, ${shortDate(day.date)}${day.tasks.length && day.tasks.every((t) => t.school) ? ' (Berufsschule)' : ''}`);
        for (const line of lines) out.push(`${bullet}${line}`);
        out.push('');
      }
      while (out.length && out[out.length - 1] === '') out.pop();
    } else {
      const all = state.days.flatMap((day) => taskLines(day.tasks));
      const lines = state.opts.merge ? [...new Set(all)] : all;
      for (const line of lines) out.push(`${bullet}${line}`);
    }

    return out.join('\n');
  }

  function renderLabel(start, end) {
    const [, m1, d1] = start.split('-').map(Number);
    const [y2, m2, d2] = end.split('-').map(Number);
    const month = (m) => new Date(2000, m - 1, 1).toLocaleDateString('de-DE', { month: 'long' });
    els.weekEyebrow.textContent = `Berichte · Kalenderwoche ${isoWeek(start)}`;
    els.weekLabel.textContent = m1 === m2 ? `${d1}. – ${d2}. ${month(m2)} ${y2}` : `${d1}. ${month(m1)} – ${d2}. ${month(m2)} ${y2}`;
  }

  /** Die Woche auf einen Blick: Mo–Fr (Sa/So nur mit Einträgen), Berufsschule und heute markiert. */
  function renderDays() {
    const today = todayISO();
    els.weekDays.innerHTML = state.days
      .filter((d, i) => i < 5 || d.tasks.length)
      .map((d) => {
        const n = d.tasks.length;
        const school = n > 0 && d.tasks.every((t) => t.school);
        const tag = school ? '<span class="week-day__tag week-day__tag--school">Schule</span>' : d.date === today ? '<span class="week-day__tag">Heute</span>' : '';
        const sub = school ? 'Berufsschule' : n ? `${n} ${n === 1 ? 'Eintrag' : 'Einträge'}` : d.date > today ? '' : 'nichts erfasst';
        const [, , dd] = d.date.split('-');
        const label = `${weekdayName(d.date).slice(0, 2)} ${dd}.${d.date.slice(5, 7)}.`;
        return `<div class="week-day${d.date === today ? ' is-today' : ''}${n ? '' : ' week-day--empty'}"><span class="week-day__head"><strong>${label}</strong>${tag}</span><span class="week-day__sub">${sub}</span></div>`;
      }).join('');
  }

  function render() {
    const start = state.weekStart;
    const end = shiftDate(start, 6);
    renderLabel(start, end);
    renderDays();
    renderOpts();

    const text = buildReport();
    const empty = text.trim() === '';
    els.reportPreview.textContent = empty ? 'Keine Einträge in dieser Woche.' : text;
    els.reportPreview.classList.toggle('report-preview--empty', empty);
    els.copyBtn.disabled = empty;
    els.downloadBtn.disabled = empty;
    // Die Berichtsheft-KI (berichtsheft.js) arbeitet mit derselben Woche
    document.dispatchEvent(new CustomEvent('weekchange', { detail: { from: start, to: end } }));
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
    // Der Berichtsheft-Text ist für Azubis (Einstellungen → Allgemein → „Ich bin Azubi“)
    els.bhCard.classList.toggle('hidden', !me.user.isApprentice);
    els.grid.classList.toggle('reports-grid--single', !me.user.isApprentice);
    await Api.primeCsrf();
    await loadWeek(todayISO());
  }

  document.querySelectorAll('[data-opt]').forEach((b) => b.addEventListener('click', () => {
    state.opts[b.dataset.opt] = b.dataset.value;
    saveOpts();
    if (state.weekStart) render();
  }));
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
    state.opts[b.dataset.toggle] = !state.opts[b.dataset.toggle];
    saveOpts();
    if (state.weekStart) render();
  }));
  renderOpts();

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
