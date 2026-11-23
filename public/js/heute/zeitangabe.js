'use strict';

// Zeit angeben beim Nachtragen: Zeitraum (Start–Ende) oder Dauer, gegenseitig umgerechnet, mit Zuschlag und
// zusammengeführter Zeit in der Rechnung ("= 45 Min + 5 Min Zuschlag = 50 Min") und Warnung bei Überschneidungen.
// Teil der Seite "Heute" (index.html); gemeinsamer Zustand in heute/kern.js, Start in heute/start.js.
(function () {
  const H = window.Heute;
  const { state, els, formState, MAX_DURATION_MINUTES, ENTRY_MODE_KEY } = H;
  // aus anderen Teilen (erst beim Aufruf nachgeschlagen, weil die Dateien nacheinander laden)
  const { currentSurcharge, describeSurcharge, effectiveEnd, surchargeBounds } = H.later;

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

  Object.assign(H, { applyDuration, describeTotal, setEntryMode, syncDurationFromTimes, updateDurationHint, updateOverlapHint });
})();
