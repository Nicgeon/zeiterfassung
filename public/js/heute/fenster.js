'use strict';

// Mini-Fenster und Fensterwechsel: "Noch in Jira eintragen", automatisch kopieren, Fenstergröße, Abgleich zwischen Fenstern.
// Teil der Seite "Heute" (index.html); gemeinsamer Zustand in heute/kern.js, Start in heute/start.js.
(function () {
  const H = window.Heute;
  const { $, state, els, formState } = H;
  // aus anderen Teilen (erst beim Aufruf nachgeschlagen, weil die Dateien nacheinander laden)
  const { renderLedger, renderResumeBar, renderTimer, resetFormForNewEntry, setHtml } = H.later;

  // --- Mini-Fenster: "Noch in Jira eintragen" ------------------------------------------------------
  // Die Tagesliste fehlt im Mini-Fenster. Damit man zum Einfuegen in Jira nicht ins grosse Fenster wechseln muss,
  // stehen hier die juengsten noch nicht uebertragenen Eintraege mit Kopieren-Knopf und "in Jira"-Haken.
  const AUTO_COPY_KEY = 'zeit.miniAutoCopy';
  const MINI_RECENT_MAX = 2;
  const autoCopyOn = () => { try { return localStorage.getItem(AUTO_COPY_KEY) === '1'; } catch { return false; } };

  function renderMiniRecent() {
    if (!document.documentElement.classList.contains('mini')) return;
    const open = state.entries.filter((e) => !e.transferred).sort((a, b) => b.id - a.id);
    els.miniRecent.classList.toggle('hidden', open.length === 0);
    if (open.length === 0) { setHtml(els.miniRecent, ''); return; }
    const check = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    setHtml(els.miniRecent, `
      <div class="mini-resume__head">
        <span>Noch in Jira eintragen</span><span class="mini-resume__count">${open.length}</span>
        <label class="mini-recent__auto" title="Beim Speichern oder Stoppen den Eintrag automatisch in die Zwischenablage kopieren">
          <input type="checkbox" id="miniAutoCopy"${autoCopyOn() ? ' checked' : ''}> Automatisch kopieren
        </label>
      </div>
      ${open.slice(0, MINI_RECENT_MAX).map((e) => `
        <div class="mini-resume__row" data-id="${e.id}">
          <button type="button" class="mini-recent__copy" data-copy aria-label="Eintrag kopieren" title="Kopieren – zum Einfügen in Jira">${ICONS.copy}</button>
          <div class="mini-resume__text">
            <div class="mini-resume__title">${escapeHtml(e.description || e.jiraKey || '')}</div>
            <div class="mini-resume__sub mono">${escapeHtml([e.description && e.jiraKey ? e.jiraKey : '', formatDurationLong(e.durationMinutes)].filter(Boolean).join(' · '))}</div>
          </div>
          <button type="button" class="mini-resume__btn" data-done aria-label="Als in Jira eingetragen markieren" title="In Jira eingetragen – aus dieser Liste entfernen">${check}</button>
        </div>`).join('')}
      ${open.length > MINI_RECENT_MAX ? `<div class="mini-recent__more">+ ${open.length - MINI_RECENT_MAX} weitere im großen Fenster</div>` : ''}`);
  }

  els.miniRecent.addEventListener('change', (e) => {
    if (e.target.id !== 'miniAutoCopy') return;
    try { localStorage.setItem(AUTO_COPY_KEY, e.target.checked ? '1' : '0'); } catch { /* nur Komfort */ }
  });
  els.miniRecent.addEventListener('click', async (e) => {
    const row = e.target.closest('.mini-resume__row');
    if (!row) return;
    const entry = state.entries.find((x) => x.id === Number(row.dataset.id));
    if (!entry) return;
    if (e.target.closest('[data-copy]')) {
      const ok = await copyToClipboard(entryLine(entry, loadShowTimes()));
      showToast(ok ? 'Eintrag kopiert.' : 'Kopieren fehlgeschlagen.');
    } else if (e.target.closest('[data-done]')) {
      try {
        await Api.patch(`/api/entries/${entry.id}/transferred`, { transferred: true });
        entry.transferred = true;
        renderLedger();
      } catch (err) {
        showToast(err.message);
      }
    }
  });

  /** Mini-Fenster mit "Automatisch kopieren": den gerade angelegten Eintrag in die Zwischenablage legen. */
  async function autoCopyEntry(entry) {
    if (!entry || !document.documentElement.classList.contains('mini') || !autoCopyOn()) return '';
    return (await copyToClipboard(entryLine(entry, loadShowTimes()))) ? ' In die Zwischenablage kopiert.' : '';
  }

  // --- Mini-Fenster und Abgleich zwischen Fenstern ------------------------------------------------
  // Das Mini-Fenster ist dieselbe Seite im Kompaktmodus (index.html?mini=1): Timer, Zuschlag, Zusammenführen
  // usw. funktionieren damit genauso. Beide Fenster gleichen sich beim Zurückkehren mit dem Server ab.
  const isMini = document.documentElement.classList.contains('mini');

  /**
   * Fenster oeffnen. Erste Wahl: ein Popup aus dieser Seite heraus - der Browser oeffnet es selbst, es kommt
   * zuverlaessig nach vorn und besteht auch, wenn das Fenster, aus dem es geoeffnet wurde, geschlossen wird.
   * (Ein weiterer Browser-Prozess ueber den Starter bekommt unter Windows nicht immer den Vordergrund.)
   * Zweite Wahl, falls der Browser das Popup blockiert: der Starter (Programm-Modus).
   */
  async function openAppWindow(kind) {
    const mini = kind === 'mini';
    const width = mini ? 460 : Math.min(1280, Math.max(900, (window.screen.availWidth || 1280) - 80));
    const height = mini ? 400 : Math.min(860, Math.max(600, (window.screen.availHeight || 860) - 80));
    const w = window.open(mini ? '/index.html?mini=1' : '/index.html', mini ? 'zeit-mini' : 'zeit-main', `popup=yes,width=${width},height=${height}`);
    if (w) { w.focus(); return true; }
    try {
      const r = await Api.post('/api/app/window', { kind });
      return !!(r && r.opened);
    } catch { return false; }
  }

  els.miniBtn.addEventListener('click', async () => {
    if (!(await openAppWindow('mini'))) return showToast('Das Mini-Fenster konnte nicht geöffnet werden (Pop-ups für diese Seite erlauben).');
    // Im Programm-Fenster schliesst sich das grosse Fenster, sobald das Mini-Fenster da ist (andernfalls bleibt es offen,
    // z. B. in einem normalen Browser-Tab). Das Programm laeuft weiter, solange das Mini-Fenster offen ist.
    if (window.zeitAppMode) {
      setTimeout(() => window.close(), 700);
      // Der Browser erlaubt Skripten nicht immer, ein Fenster zu schliessen, das sie nicht selbst geoeffnet haben
      setTimeout(() => showToast('Das große Fenster lässt sich nicht automatisch schließen – du kannst es jetzt selbst schließen.'), 1400);
    }
  });

  // Mini -> gross: das grosse Fenster oeffnen (oder in den Vordergrund holen), dieses Mini-Fenster schliesst sich
  els.miniMainBtn.addEventListener('click', async () => {
    if (!(await openAppWindow('main'))) return showToast('Das Fenster konnte nicht geöffnet werden (Pop-ups für diese Seite erlauben).');
    setTimeout(() => window.close(), 700);
  });

  /** Fenstergröße an den Inhalt anpassen (nur im Mini-Fenster; der Browser darf das bei eigenen Fenstern). */
  let fitTimer = null;
  function fitMini() {
    if (!isMini) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      try {
        const bottoms = [...document.querySelectorAll('#composer, #miniTimelineCard, #tasksCol, #miniRecent')]
          .filter((el) => !el.classList.contains('hidden'))
          .map((el) => el.getBoundingClientRect().bottom);
        const wanted = Math.ceil(Math.max(...bottoms) + window.scrollY + 12);
        if (Math.abs(window.innerHeight - wanted) > 3) window.resizeTo(window.outerWidth, wanted + (window.outerHeight - window.innerHeight));
      } catch { /* nur Komfort */ }
    }, 120);
  }
  if (isMini && typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(fitMini);
    ro.observe(els.composer);
    ro.observe(document.getElementById('tasksCol'));
    ro.observe(els.miniRecent);
    ro.observe(document.getElementById('miniTimelineCard'));
  }
  let syncing = false;
  let lastSync = 0;
  /** Eintraege und Timer neu laden (z. B. wenn im anderen Fenster etwas gespeichert wurde), ohne Eingaben zu verlieren. */
  async function syncFromServer() {
    if (syncing || document.hidden || Date.now() - lastSync < 1500) return;
    syncing = true;
    try {
      const [entries, timer] = await Promise.all([Api.get(`/api/entries?date=${state.viewDate}`), Api.get('/api/timer')]);
      state.entries = entries.entries;
      renderLedger();
      renderTimer(timer.timer);
      renderResumeBar();
      if (window.ZeitTasks) window.ZeitTasks.refresh();
      // Noch nichts eingegeben: Formular mit frischen Vorgaben (z. B. Start = Ende des letzten Eintrags)
      if (!state.editingId && !state.timer && !els.description.value.trim() && !els.jiraKey.value.trim()) resetFormForNewEntry();
    } catch { /* offline o. ae.: beim naechsten Mal */ } finally {
      lastSync = Date.now();
      syncing = false;
    }
  }
  window.addEventListener('focus', syncFromServer);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncFromServer(); });


  Object.assign(H, { autoCopyEntry, autoCopyOn, fitMini, openAppWindow, renderMiniRecent, syncFromServer });
})();
