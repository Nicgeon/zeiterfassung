'use strict';

// Erfassen: Jetzt-Karte ("Jetzt starten" / "Nachtragen"), Lücke nachtragen, neuer Eintrag, Bearbeiten, Speichern
// (mit Zusammenführen und "Speichern & unterbrechen"). Zeitangaben stehen in heute/zeitangabe.js, Vorschläge und
// Ticket-Links in heute/eingabe.js.
// Teil der Seite "Heute" (index.html); gemeinsamer Zustand in heute/kern.js, Start in heute/start.js.
(function () {
  const H = window.Heute;
  const { state, els, formState } = H;
  // aus anderen Teilen (erst beim Aufruf nachgeschlagen, weil die Dateien nacheinander laden)
  const {
    addPausedTask, applyDuration, autoCopyEntry, effectiveEnd, loadEntries, removePausedTaskByEntry, setEntryMode,
    stopTimer, syncDurationFromTimes, typicalSurcharge, updateDurationHint,
  } = H.later;

  // --- Jetzt-Karte: "Jetzt starten" (eine Zeile + Timer) oder "Nachtragen" (ganzes Formular) ------------------
  const composeView = () => els.composer.dataset.view || 'add';
  function setComposeView(view) {
    const v = view === 'add' ? 'add' : 'start';
    els.composer.dataset.view = v;
    els.jiraKey.placeholder = v === 'start' ? 'Ticket (optional)' : 'z. B. ITPKK-123 oder Link';
    els.composer.querySelectorAll('[data-compose]').forEach((b) => {
      const on = b.dataset.compose === v;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  els.composer.addEventListener('click', (e) => {
    const b = e.target.closest('[data-compose]');
    if (!b) return;
    setComposeView(b.dataset.compose);
    (b.dataset.compose === 'add' ? (formState.mode === 'duration' ? els.duration : els.startTime) : els.description).focus();
  });

  /** Lücke im Zeitstrahl nachtragen: Nachtragen-Ansicht mit genau diesem Zeitraum. */
  function fillGap(start, end) {
    if (state.timer) { showToast('Bitte zuerst den Timer stoppen oder unterbrechen.'); return; }
    resetFormForNewEntry();
    setComposeView('add');
    const minutes = hmToMinutes(end) - hmToMinutes(start);
    if (loadShowTimes()) {
      setEntryMode('times');
      els.startTime.value = start;
      els.endTime.value = end;
      formState.anchor = 'times';
      formState.startIsDefault = false;
      syncDurationFromTimes();
      updateDurationHint();
    } else {
      els.startTime.value = start;
      formState.startIsDefault = false;
      els.duration.value = formatDurationField(minutes);
      applyDuration();
    }
    formState.gapFill = true;
    els.composer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    els.description.focus();
    showToast(`Zeitraum ${start}–${end} übernommen – jetzt Aufgabe eintragen.`);
  }

  /** Hinweis, solange die Zeit eines unterbrochenen Teils auf den neuen Eintrag draufgelegt wird. */
  function renderMergeBanner() {
    const m = formState.merge;
    els.mergeBanner.classList.toggle('hidden', !m);
    els.mergeText.textContent = m
      ? `Weitermachen mit „${m.label}“: ${m.carry} Min vom unterbrochenen Teil werden auf diesen Eintrag draufgelegt, der frühere Teil entfällt.`
      : '';
  }

  function defaultStartTime() {
    if (state.entries.length === 0) {
      // Ohne sichtbare Uhrzeiten braucht auch ein leerer Vortag einen (unsichtbaren) Start.
      return isTodayISO(state.viewDate) ? nowHHMM() : loadShowTimes() ? '' : '08:00';
    }
    // Kette an das Ende des letzten (spaetesten) Eintrags des Tages an -
    // unabhaengig von der gewaehlten Anzeigereihenfolge.
    return state.entries.reduce((latest, e) => (e.endTime > latest ? e.endTime : latest), '');
  }

  function resetFormForNewEntry() {
    state.editingId = null;
    state.editSurcharge = 0;
    formState.merge = null;
    formState.gapFill = false;
    renderMergeBanner();
    els.composer.classList.remove('composer--editing');
    els.formTitle.textContent = state.timer ? 'Timer läuft' : 'Neuer Eintrag';
    els.saveBtn.textContent = 'Eintrag speichern';
    els.cancelEditBtn.classList.add('hidden');
    els.startTime.value = defaultStartTime();
    // Im Dauer-Modus ergibt sich das Ende aus der Dauer, im Zeitraum-Modus ist "jetzt" vorbelegt.
    els.endTime.value = isTodayISO(state.viewDate) && formState.mode === 'times' ? nowHHMM() : '';
    formState.anchor = formState.mode === 'duration' ? 'duration' : 'times';
    formState.startIsDefault = true;
    formState.durationError = '';
    els.duration.value = '';
    // Beim laufenden Timer stehen Aufgabe und Ticket des Timers in diesen Feldern - nicht leeren.
    if (!state.timer) {
      els.description.value = '';
      els.jiraKey.value = '';
    }
    els.schoolDay.checked = false;
    setFormError(els.formError, '');
    updateDurationHint();
  }

  function fillFormForEdit(entry) {
    setComposeView('add');
    state.editingId = entry.id;
    formState.merge = null;
    renderMergeBanner();
    els.composer.classList.add('composer--editing');
    els.formTitle.textContent = 'Eintrag bearbeiten';
    els.saveBtn.textContent = 'Aktualisieren';
    els.cancelEditBtn.classList.remove('hidden');
    // Im Formular steht die Zeit ohne Zuschlag; er kommt beim Speichern wieder dazu. Ist der Eintrag
    // kuerzer als der Zuschlag (etwa vor dessen Einfuehrung angelegt), bleibt er unveraendert.
    // Bei einem Zufallsbereich ist der enthaltene Zuschlag nicht bekannt: Der Eintrag bleibt dann
    // wie gespeichert, und beim Speichern kommt nichts dazu.
    const range = loadSurchargeRange();
    const sur = surchargeIsRandom(range) ? 0 : range.min;
    state.editSurcharge = entry.durationMinutes > sur ? sur : 0;
    els.startTime.value = entry.startTime;
    els.endTime.value = minutesToHM(hmToMinutes(entry.endTime) - state.editSurcharge);
    formState.anchor = 'times';
    formState.startIsDefault = false;
    formState.durationError = '';
    syncDurationFromTimes();
    els.description.value = entry.description;
    els.jiraKey.value = entry.jiraKey || '';
    els.schoolDay.checked = !!entry.school;
    setFormError(els.formError, '');
    updateDurationHint();
    els.description.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Neuen Eintrag mit Text und Ticket eines vorhandenen vorbefuellen (Zeiten wie bei jedem neuen Eintrag). */
  function startFromEntry(entry) {
    resetFormForNewEntry();
    els.description.value = entry.description;
    els.jiraKey.value = entry.jiraKey || '';
    els.schoolDay.checked = !!entry.school;
    // Dauer uebernehmen: Start wie bei jedem neuen Eintrag (Ende des letzten bzw. jetzt),
    // das Ende ergibt sich aus der Dauer des Vorbilds.
    // Der Vorbild-Eintrag enthaelt den Zuschlag schon; er kommt beim Speichern wieder dazu.
    // (bei einem Zufallsbereich ungefaehr: der mittlere Zuschlag wird abgezogen)
    els.duration.value = formatDurationField(Math.max(1, entry.durationMinutes - typicalSurcharge()));
    formState.anchor = 'duration';
    applyDuration();
    els.description.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast('Text, Ticket und Dauer übernommen – Zeiten prüfen.');
  }

  els.cancelEditBtn.addEventListener('click', () => resetFormForNewEntry());

  /** Eintrag speichern; mit pause wird die Aufgabe zusaetzlich zum Weitermachen gemerkt. */
  async function saveEntry({ pause = false } = {}) {
    setFormError(els.formError, '');
    if (state.timer) return stopTimer(); // Strg+Enter beim laufenden Timer: stoppen und eintragen
    if (formState.durationError) return setFormError(els.formError, formState.durationError);
    if (!els.description.value.trim() && !convertTicketLinks(els.jiraKey.value).trim()) {
      return setFormError(els.formError, 'Bitte eine Aufgabe oder ein Ticket angeben.');
    }
    if (!els.startTime.value || !els.endTime.value) {
      return setFormError(els.formError, 'Bitte einen Zeitraum oder eine Dauer angeben.');
    }
    // Zuschlag auf die Eingabe (auch beim Bearbeiten; dort steckt er nicht im Formular)
    if (!effectiveEnd(els.endTime.value)) {
      return setFormError(
        els.formError,
        loadShowTimes()
          ? 'Mit Zuschlag endet der Eintrag nach Mitternacht – bitte Zeit anpassen.'
          : 'Der Tag ist voll – der Eintrag würde über Mitternacht hinausgehen.'
      );
    }
    // Beim Bearbeiten steht der Zuschlag fest, sonst wird er (ggf. zufaellig) gewuerfelt, aber nie ueber 23:59
    const endMinutes = hmToMinutes(els.endTime.value);
    const surcharge = Math.min(state.editingId ? state.editSurcharge : rollSurcharge(), 24 * 60 - 1 - endMinutes);
    const endWithSurcharge = minutesToHM(endMinutes + surcharge);
    const description = convertTicketLinks(els.description.value);
    const jiraKey = convertTicketLinks(els.jiraKey.value).trim().slice(0, 40) || null;
    const payload = {
      work_date: state.viewDate,
      start_time: els.startTime.value,
      end_time: endWithSurcharge,
      description,
      jira_key: jiraKey,
      school: els.schoolDay.checked,
      // Mit Uhrzeiten eingegeben: echter Arbeitszeitraum (für den Zeitstrahl); nur Dauer: Zeitpunkt unbekannt
      real_times: (loadShowTimes() && formState.mode === 'times') || formState.gapFill,
      real_end_time: els.endTime.value, // Ende ohne Zuschlag: so endet der Block im Zeitstrahl
    };
    const merge = !state.editingId && formState.merge ? { ...formState.merge } : null;
    if (merge) {
      payload.merge_entry_id = merge.entryId;
      payload.carry_minutes = merge.carry;
    }
    els.saveBtn.disabled = true;
    els.pauseEntryBtn.disabled = true;
    try {
      if (state.editingId) {
        const res = await Api.put(`/api/entries/${state.editingId}`, { ...payload, with_times: loadShowTimes() });
        // Bearbeitung ist abgeschlossen - sonst bliebe die Maske im
        // Bearbeiten-Modus stehen, weil loadEntries() das Formular nur
        // zuruecksetzt, solange keine Bearbeitung laeuft.
        state.editingId = null;
        // Stand der Eintrag schon als Kommentar in Jira, wurde dieser mitgeändert
        showToast(res.jira ? (res.jira.ok ? 'Eintrag aktualisiert – der Kommentar in Jira auch.' : `Eintrag aktualisiert, der Kommentar in Jira aber nicht: ${res.jira.error}`) : 'Eintrag aktualisiert.');
      } else {
        let data;
        let merged = false;
        let fellBack = false;
        try {
          data = await Api.post('/api/entries', payload);
          merged = !!merge;
        } catch (err) {
          if (!merge || !(err.status === 409 && err.data && err.data.mergeRejected)) throw err;
          // Zusammenfuehren nicht moeglich: als eigener Eintrag speichern
          delete payload.merge_entry_id;
          delete payload.carry_minutes;
          data = await Api.post('/api/entries', payload);
          fellBack = true;
          showToast(`${err.message} Der neue Teil wurde als eigener Eintrag gespeichert.`);
        }
        if (merged) removePausedTaskByEntry(merge.entryId);
        const copied = await autoCopyEntry(data.entry);
        if (pause) {
          addPausedTask({
            description: description.trim(),
            jiraKey: jiraKey || '',
            entryId: data.entry.id,
            minutes: data.entry.durationMinutes,
            workDate: data.entry.workDate,
            surcharge,
          });
          showToast(`Eintrag gespeichert – „${description.trim() || jiraKey}" ist unterbrochen. Oben geht es mit „Weitermachen" weiter.${copied}`, { durationMs: 6000 });
        } else if (merged) {
          showToast(`Eintrag gespeichert – der frühere Teil wurde übernommen.${copied}`);
        } else if (!fellBack) {
          showToast(`Eintrag gespeichert.${copied}`);
        }
      }
      await loadEntries();
    } catch (err) {
      setFormError(els.formError, err.message);
    } finally {
      els.saveBtn.disabled = false;
      els.pauseEntryBtn.disabled = false;
    }
  }

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (composeView() === 'start' && !state.timer && !state.editingId) { els.timerStartBtn.click(); return; }
    saveEntry();
  });
  // Aufklappmenue am Speichern-Knopf
  function toggleSaveMenu(open) {
    const show = open === undefined ? els.saveMenu.classList.contains('hidden') : open;
    els.saveMenu.classList.toggle('hidden', !show);
    els.saveMenuBtn.setAttribute('aria-expanded', String(show));
  }
  els.saveMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSaveMenu();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.split')) toggleSaveMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleSaveMenu(false);
  });
  els.pauseEntryBtn.addEventListener('click', () => {
    toggleSaveMenu(false);
    saveEntry({ pause: true });
  });
  els.mergeCancelBtn.addEventListener('click', () => {
    formState.merge = null;
    renderMergeBanner();
    updateDurationHint();
  });

  Object.assign(H, { composeView, defaultStartTime, fillFormForEdit, fillGap, renderMergeBanner, resetFormForNewEntry, saveEntry, setComposeView, startFromEntry, toggleSaveMenu });
})();
