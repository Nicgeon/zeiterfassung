'use strict';

// Erfassen: Jetzt-Karte ("Jetzt starten" / "Nachtragen"), Dauer und Zeitraum, Vorschläge, Speichern und Bearbeiten.
// Teil der Seite "Heute" (index.html); gemeinsamer Zustand in heute/kern.js, Start in heute/start.js.
(function () {
  const H = window.Heute;
  const { $, state, els, formState, MAX_DURATION_MINUTES, ENTRY_MODE_KEY } = H;
  // aus anderen Teilen (erst beim Aufruf nachgeschlagen, weil die Dateien nacheinander laden)
  const { addPausedTask, autoCopyEntry, currentSurcharge, describeSurcharge, effectiveEnd, loadEntries, removePausedTaskByEntry, saveTimerFields, stopTimer, surchargeBounds, typicalSurcharge } = H.later;

  /** "= 45 Min + 35 Min aus dem unterbrochenen Teil + 5 Min Zuschlag = 1 Std 25 Min" */
  function describeTotal(base) {
    const carry = formState.merge ? formState.merge.carry : 0;
    const range = surchargeBounds();
    if (!carry && !range.max) return `= ${formatDurationLong(base)}`;
    const total = surchargeIsRandom(range)
      ? `${formatDurationLong(base + carry + range.min)} – ${formatDurationLong(base + carry + range.max)}`
      : formatDurationLong(base + carry + range.min);
    return (
      `= ${formatDurationLong(base)}` +
      (carry ? ` + ${carry} Min aus dem unterbrochenen Teil` : '') +
      (range.max ? ` + ${describeSurcharge(range)}` : '') +
      ` = ${total}`
    );
  }

  /** Zusammenfassung neben den Zeitfeldern: im Zeitraum-Modus die Dauer, im Dauer-Modus der Zeitraum. */
  function updateDurationHint() {
    updateOverlapHint();
    const s = els.startTime.value;
    const e = els.endTime.value;
    const diff = s && e ? hmToMinutes(e) - hmToMinutes(s) : 0;
    let text = '';
    let isError = false;
    if (formState.durationError) {
      text = formState.durationError;
      isError = true;
    } else if (formState.mode === 'times' && s && e && diff <= 0) {
      text = 'Ende muss nach dem Start liegen.';
      isError = true;
    } else if (diff > 0 && currentSurcharge() > 0 && els.endTime.value && !effectiveEnd(e)) {
      text = loadShowTimes()
        ? 'Mit Zuschlag endet der Eintrag nach Mitternacht – bitte Zeit anpassen.'
        : 'Der Tag ist voll – der Eintrag würde über Mitternacht hinausgehen.';
      isError = true;
    } else if (!loadShowTimes()) {
      // Ohne Uhrzeiten zeigt die Zusammenfassung nur die Rechnung der Dauer
      const minutes = parseDuration(els.duration.value);
      if (minutes && minutes > 0 && minutes <= MAX_DURATION_MINUTES) text = describeTotal(minutes);
    } else if (formState.mode === 'times') {
      if (diff > 0) text = describeTotal(diff);
    } else if (diff > 0 && els.duration.value.trim()) {
      const range = surchargeBounds();
      const carry = formState.merge ? formState.merge.carry : 0;
      text = `${s} – ${e} Uhr` + (carry ? ` + ${carry} Min aus dem unterbrochenen Teil` : '') +
        (range.max > 0 ? ` + ${describeSurcharge(range)}` : '') +
        (range.max > 0 && !surchargeIsRandom(range) ? ` → Ende ${effectiveEnd(e)}` : '');
    } else if (s) {
      text = `Beginnt um ${s}, das Ende ergibt sich aus der Dauer.`;
    }
    els.durationHint.textContent = text || '';
    els.durationHint.classList.toggle('is-error', isError);
  }

  function setEntryMode(requested, { focus } = {}) {
    const mode = loadShowTimes() ? requested : 'duration';
    formState.mode = mode;
    els.composer.dataset.mode = mode;
    els.modeTimesBtn.classList.toggle('is-active', mode === 'times');
    els.modeDurationBtn.classList.toggle('is-active', mode === 'duration');
    els.modeTimesBtn.setAttribute('aria-pressed', String(mode === 'times'));
    els.modeDurationBtn.setAttribute('aria-pressed', String(mode === 'duration'));
    if (mode === 'duration') {
      formState.anchor = 'duration';
      if (!els.duration.value) syncDurationFromTimes();
    }
    updateDurationHint();
    if (focus) (mode === 'duration' ? els.duration : els.startTime).focus();
  }

  /** Dauerfeld aus Start und Ende fuellen (oder leeren, wenn dort nichts Gueltiges steht). */
  function syncDurationFromTimes() {
    const s = els.startTime.value;
    const e = els.endTime.value;
    const diff = s && e ? hmToMinutes(e) - hmToMinutes(s) : 0;
    els.duration.value = diff > 0 ? formatDurationField(diff) : '';
  }

  /** Das Dauerfeld wurde geaendert: Ende (bzw. Start) daraus berechnen. */
  function applyDuration() {
    formState.durationError = '';
    const raw = els.duration.value.trim();
    if (raw) {
      const minutes = parseDuration(raw);
      if (minutes === null || minutes <= 0) {
        formState.durationError = 'Dauer nicht erkannt – z. B. 45, 1:30 oder 1,5h.';
      } else if (minutes > MAX_DURATION_MINUTES) {
        formState.durationError = 'Dauer wirkt unrealistisch hoch (mehr als 16 Stunden).';
      } else {
        const start = els.startTime.value;
        const end = els.endTime.value;
        const noEntriesToday = state.entries.length === 0 && isTodayISO(state.viewDate) && !state.editingId;
        if (formState.startIsDefault && noEntriesToday) {
          // Erster Eintrag heute: die Arbeit ist gerade fertig, also endet sie jetzt.
          const now = hmToMinutes(nowHHMM());
          if (now - minutes < 0) {
            formState.durationError = 'Das würde vor Mitternacht beginnen – bitte Start von Hand eintragen.';
          } else {
            els.startTime.value = minutesToHM(now - minutes);
            els.endTime.value = minutesToHM(now);
          }
        } else if (start) {
          const total = hmToMinutes(start) + minutes;
          if (total > 24 * 60 - 1) {
            formState.durationError = 'Endet nach Mitternacht – bitte auf zwei Einträge aufteilen.';
          } else {
            els.endTime.value = minutesToHM(total);
          }
        } else if (end) {
          const from = hmToMinutes(end) - minutes;
          if (from < 0) formState.durationError = 'Das würde vor Mitternacht beginnen.';
          else els.startTime.value = minutesToHM(from);
        } else {
          formState.durationError = 'Bitte Start oder Ende angeben.';
        }
      }
    }
    updateDurationHint();
  }

  // --- Jetzt-Karte: "Jetzt starten" (eine Zeile + Timer) oder "Nachtragen" (ganzes Formular) ------------------
  const composeView = () => els.composer.dataset.view || 'add';
  function setComposeView(view) {
    const v = document.documentElement.classList.contains('mini') ? 'add' : view;
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

  /** Warnt (ohne zu blockieren), wenn der Zeitraum einen anderen Eintrag des Tages ueberschneidet. */
  function updateOverlapHint() {
    const s = els.startTime.value;
    const e = els.endTime.value ? effectiveEnd(els.endTime.value) || els.endTime.value : '';
    let text = '';
    if (loadShowTimes() && !formState.merge && s && e && e > s) {
      const hits = state.entries.filter((x) => x.id !== state.editingId && x.startTime < e && s < x.endTime);
      if (hits.length > 0) {
        text = `⚠ Überschneidet sich mit ${hits.map((x) => `${x.startTime}–${x.endTime}`).join(', ')}.`;
      }
    }
    els.overlapHint.textContent = text;
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

  function attachSuggest(input, list, onApply) {
    let timer = null;
    let suggestions = [];

    const hide = () => list.classList.add('hidden');

    function render() {
      if (suggestions.length === 0) return hide();
      list.innerHTML = suggestions
        .map(
          (s, i) => `<li class="suggest-item" data-index="${i}">
              <span>${escapeHtml(s.description)}</span>
              ${s.jiraKey ? `<span class="jira-tag">${escapeHtml(s.jiraKey)}</span>` : ''}
            </li>`
        )
        .join('');
      list.classList.remove('hidden');
    }

    async function fetchSuggestions() {
      const query = input.value.trim();
      // Mehrzeilige Texte sind meist fertig getippt - dann nicht vorschlagen.
      if (query.includes('\n')) return hide();
      try {
        const data = await Api.get(`/api/entries/suggestions?q=${encodeURIComponent(query)}`);
        suggestions = data.suggestions.filter((s) => s.description !== query);
        // Antwort kam erst nach dem Verlassen des Feldes: Liste nicht mehr einblenden
        if (document.activeElement !== input) return hide();
        render();
      } catch {
        hide();
      }
    }

    const schedule = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(fetchSuggestions, ms);
    };

    input.addEventListener('input', () => schedule(180));
    input.addEventListener('focus', () => schedule(120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hide();
    });
    input.addEventListener('blur', () => {
      clearTimeout(timer);
      setTimeout(hide, 120);
    });
    list.addEventListener('mousedown', (e) => {
      // mousedown statt click: sonst schliesst das blur-Ereignis die Liste zuerst
      const item = e.target.closest('.suggest-item');
      if (!item) return;
      e.preventDefault();
      const suggestion = suggestions[Number(item.dataset.index)];
      if (!suggestion) return;
      input.value = suggestion.description;
      hide();
      input.focus();
      onApply(suggestion);
    });
  }

  attachSuggest(els.description, els.suggestList, (s) => {
    if (s.jiraKey && !els.jiraKey.value.trim()) els.jiraKey.value = s.jiraKey;
    saveTimerFields(); // wirkt nur, solange ein Timer laeuft
  });



  // --- Jira-Links -> Ticketnummern ----------------------------------
  /** Ticketfeld: ein eingefuegter Jira-Link wird sofort zur Ticketnummer. */
  function convertLinksInTicketField(input, onChange) {
    input.addEventListener('input', () => {
      const converted = convertTicketLinks(input.value);
      if (converted === input.value) return;
      input.value = converted.trim();
      if (onChange) onChange();
    });
  }

  /**
   * Textfeld: Jira-Links im eingefuegten Text werden zu Ticketnummern. Ist das
   * Ticketfeld noch leer, wird die erste gefundene Nummer dort eingetragen.
   */
  function convertLinksOnPaste(input, onTicketKey) {
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData && e.clipboardData.getData('text');
      if (!text) return;
      const converted = convertTicketLinks(text);
      if (converted === text) return;
      e.preventDefault();
      // insertText erhaelt den Rueckgaengig-Verlauf des Browsers
      if (!document.execCommand('insertText', false, converted)) {
        input.setRangeText(converted, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const key = firstLinkedKey(text);
      if (key) onTicketKey(key);
    });
  }

  convertLinksInTicketField(els.jiraKey, saveTimerFields);
  convertLinksOnPaste(els.description, (key) => {
    if (!els.jiraKey.value.trim()) els.jiraKey.value = key;
    saveTimerFields();
  });

  // Strg+Enter (bzw. Cmd+Enter) speichert aus dem Textfeld; Enter im Timerfeld startet den Timer.
  els.description.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      els.form.requestSubmit();
    } else if (e.key === 'Enter' && !e.shiftKey && composeView() === 'start' && !state.timer && !state.editingId) {
      // "Jetzt starten": eine Zeile wie ein Suchfeld, Enter startet den Timer
      e.preventDefault();
      els.suggestList.classList.add('hidden');
      els.timerStartBtn.click();
    }
  });


  // --- Events -------------------------------------------------------
  els.startTime.addEventListener('input', () => {
    formState.startIsDefault = false;
    formState.durationError = '';
    if (formState.anchor === 'duration' && parseDuration(els.duration.value)) applyDuration();
    else { syncDurationFromTimes(); updateDurationHint(); }
  });
  els.endTime.addEventListener('input', () => {
    formState.anchor = 'times';
    formState.durationError = '';
    syncDurationFromTimes();
    updateDurationHint();
  });
  els.nowBtn.addEventListener('click', () => {
    els.endTime.value = nowHHMM();
    formState.anchor = 'times';
    formState.durationError = '';
    syncDurationFromTimes();
    updateDurationHint();
  });
  els.modeTimesBtn.addEventListener('click', () => {
    try { localStorage.setItem(ENTRY_MODE_KEY, 'times'); } catch { /* nur Komfort */ }
    setEntryMode('times');
  });
  els.modeDurationBtn.addEventListener('click', () => {
    try { localStorage.setItem(ENTRY_MODE_KEY, 'duration'); } catch { /* nur Komfort */ }
    setEntryMode('duration', { focus: true });
  });
  els.duration.addEventListener('input', () => { formState.anchor = 'duration'; applyDuration(); });
  els.durationChips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    els.duration.value = formatDurationField(Number(chip.dataset.minutes));
    formState.anchor = 'duration';
    applyDuration();
  });

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


  Object.assign(H, { applyDuration, attachSuggest, composeView, convertLinksInTicketField, convertLinksOnPaste, defaultStartTime, describeTotal, fillFormForEdit, fillGap, renderMergeBanner, resetFormForNewEntry, saveEntry, setComposeView, setEntryMode, startFromEntry, syncDurationFromTimes, toggleSaveMenu, updateDurationHint, updateOverlapHint });
})();
