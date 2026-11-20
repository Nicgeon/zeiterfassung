'use strict';

// Unterbrochene Aufgaben ("Pausiert"): im Browser gemerkt, mit Weitermachen, Zeit nachtragen und Entfernen.
// Teil der Seite "Heute" (index.html); gemeinsamer Zustand in heute/kern.js, Start in heute/start.js.
(function () {
  const H = window.Heute;
  const { $, state, els, formState } = H;
  // aus anderen Teilen (erst beim Aufruf nachgeschlagen, weil die Dateien nacheinander laden)
  const { loadEntries, renderMergeBanner, renderTimer, resetFormForNewEntry, setHtml, typicalSurcharge, updateDurationHint } = H.later;

  // --- Unterbrochene Aufgaben ------------------------------------------------
  // Beim Unterbrechen wird der Timer wie beim Stoppen als Eintrag gespeichert; Aufgabe und
  // Ticket merkt sich der Browser. "Weitermachen" startet einen neuen Timer damit. So
  // entstehen nahtlos anschliessende Eintraege (A, dann B, dann A) ohne Ueberschneidung.
  const PAUSED_KEY = 'zeit.pausedTasks';
  const PAUSED_MAX = 6;
  const PAUSED_MAX_AGE_MS = 36 * 3600 * 1000;

  function loadPausedTasks() {
    try {
      const list = JSON.parse(localStorage.getItem(PAUSED_KEY) || '[]');
      if (!Array.isArray(list)) return [];
      return list
        .filter((t) => t && typeof t.description === 'string' && t.at > Date.now() - PAUSED_MAX_AGE_MS)
        .slice(0, PAUSED_MAX);
    } catch {
      return [];
    }
  }

  function savePausedTasks(list) {
    try { localStorage.setItem(PAUSED_KEY, JSON.stringify(list.slice(0, PAUSED_MAX))); } catch { /* nur Komfort */ }
    renderResumeBar();
  }

  /** Zuschlag, der im frueheren Teil einer unterbrochenen Aufgabe steckt (aeltere Merkzettel: der mittlere). */
  function pausedSurcharge(task) {
    return Number.isFinite(task.surcharge) ? task.surcharge : typicalSurcharge();
  }

  function addPausedTask({ description, jiraKey, entryId, minutes, workDate, surcharge }) {
    const rest = loadPausedTasks().filter((t) => !(t.description === description && (t.jiraKey || '') === (jiraKey || '')));
    savePausedTasks([{ description, jiraKey: jiraKey || '', entryId, minutes, workDate, surcharge, at: Date.now() }, ...rest]);
  }

  function removePausedTaskByEntry(entryId) {
    savePausedTasks(loadPausedTasks().filter((t) => t.entryId !== entryId));
  }

  function renderResumeBar() {
    const list = loadPausedTasks();
    els.resumeBar.classList.toggle('hidden', list.length === 0 || !!state.timer);
    renderPausedRows(list);
  }

  /** Pausierte Aufgaben als Zeilen (Weitermachen, Zeit nachtragen, entfernen). */
  function renderPausedRows(list) {
    const play = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
    const plus = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    const cross = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    setHtml(els.resumeBar, list.length === 0 ? '' : `
      <div class="mini-resume__head"><span>Pausiert</span><span class="mini-resume__count">${list.length}</span></div>
      ${list.map((t, i) => {
        const mergeable = t.entryId && t.workDate === todayISO();
        const name = t.description || t.jiraKey;
        const sub = [t.description && t.jiraKey ? t.jiraKey : '', mergeable ? `${t.minutes} Min bisher` : ''].filter(Boolean).join(' · ');
        return `
        <div class="mini-resume__row">
          <button type="button" class="mini-resume__play chip--resume" data-index="${i}" aria-label="Weitermachen: ${escapeHtml(name)}" title="${mergeable ? `Timer weiterlaufen lassen – der bisherige Eintrag (${t.minutes} Min) wird mit dem neuen zusammengeführt` : 'Timer mit dieser Aufgabe starten'}">${play}</button>
          <div class="mini-resume__text">
            <div class="mini-resume__title">${escapeHtml(name)}</div>
            ${sub ? `<div class="mini-resume__sub mono">${escapeHtml(sub)}</div>` : ''}
          </div>
          <button type="button" class="mini-resume__btn" data-manual="${i}" aria-label="Zeit von Hand nachtragen" title="Zeit von Hand eintragen – die bisherige Zeit wird auf den neuen Eintrag draufgelegt">${plus}</button>
          <button type="button" class="mini-resume__btn mini-resume__btn--quiet" data-remove="${i}" aria-label="Aus der Liste entfernen" title="Aus der Liste entfernen">${cross}</button>
        </div>`;
      }).join('')}`);
  }

  /** Unterbrochene Aufgabe von Hand fortsetzen: Formular vorbefuellen, die bisherige Zeit kommt dazu. */
  async function resumeManually(index) {
    const task = loadPausedTasks()[index];
    if (!task) return;
    // Zusammenfuehren geht nur am selben Tag wie der fruehere Teil
    const canMerge = !!task.entryId && !!task.workDate;
    if (canMerge && task.workDate !== state.viewDate) {
      state.viewDate = task.workDate;
      await loadEntries();
    }
    resetFormForNewEntry();
    els.description.value = task.description;
    els.jiraKey.value = task.jiraKey || '';
    if (canMerge) {
      formState.merge = {
        entryId: task.entryId,
        minutes: task.minutes,
        carry: Math.max(0, task.minutes - pausedSurcharge(task)), // der Zuschlag steckt schon im frueheren Teil
        label: task.description || task.jiraKey,
      };
    }
    renderMergeBanner();
    updateDurationHint();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    (formState.mode === 'duration' ? els.duration : els.endTime).focus();
  }

  els.resumeBar.addEventListener('click', async (e) => {
    const list = loadPausedTasks();
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      list.splice(Number(removeBtn.dataset.remove), 1);
      return savePausedTasks(list);
    }
    const manualBtn = e.target.closest('[data-manual]');
    if (manualBtn) return resumeManually(Number(manualBtn.dataset.manual));
    const chip = e.target.closest('.chip--resume');
    if (!chip) return;
    const index = Number(chip.dataset.index);
    const task = list[index];
    if (!task) return;
    setFormError(els.formError, '');
    const base = {
      work_date: todayISO(),
      start_time: nowHHMM(),
      description: task.description,
      jira_key: task.jiraKey || null,
    };
    // Der fruehere Teil wird mit dem neuen zusammengefuehrt (er verschwindet, seine Zeit zaehlt
    // zum neuen Eintrag) - ausser er ist von einem anderen Tag, in Jira oder weg. Der Zuschlag
    // steckt schon im frueheren Teil und kommt beim Stoppen genau einmal dazu.
    const canMerge = task.entryId && task.workDate === todayISO();
    const carry = canMerge ? Math.max(0, task.minutes - pausedSurcharge(task)) : 0;
    try {
      let data;
      let merged = false;
      try {
        data = await Api.post('/api/timer', canMerge ? { ...base, resume_entry_id: task.entryId, carry_minutes: carry } : base);
        merged = canMerge;
      } catch (err) {
        if (!(err.status === 409 && err.data && err.data.mergeRejected)) throw err;
        // Zusammenfuehren nicht moeglich: als eigener Eintrag weitermachen
        data = await Api.post('/api/timer', base);
        showToast(`${err.message} Der neue Teil wird ein eigener Eintrag.`);
      }
      list.splice(index, 1);
      savePausedTasks(list);
      renderTimer(data.timer);
      if (merged) {
        await loadEntries();
        showToast('Timer läuft weiter – der frühere Teil wurde übernommen und zählt jetzt zu diesem Eintrag.');
      } else if (!canMerge) {
        showToast('Timer läuft wieder.');
      }
    } catch (err) {
      setFormError(els.formError, err.message);
    }
  });

  // Pausierte Aufgaben liegen im Browser-Speicher: Aenderungen im anderen Fenster uebernehmen
  window.addEventListener('storage', (e) => { if (e.key === PAUSED_KEY) renderResumeBar(); });


  Object.assign(H, { addPausedTask, loadPausedTasks, pausedSurcharge, removePausedTaskByEntry, renderPausedRows, renderResumeBar, resumeManually, savePausedTasks });
})();
