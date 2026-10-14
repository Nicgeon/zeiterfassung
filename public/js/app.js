'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    viewDate: todayISO(),
    entries: [],
    editingId: null, // wenn gesetzt: Formular ist im Bearbeiten-Modus
    editSurcharge: 0, // Zuschlag, der im bearbeiteten Eintrag steckt und beim Speichern wieder aufgeschlagen wird
    timer: null,
    sortMode: loadSortMode(),
  };

  const els = {
    userLabel: $('#userLabel'),
    adminNavLink: $('#adminNavLink'),
    logoutBtn: $('#logoutBtn'),
    form: $('#entryForm'),
    formTitle: $('#formTitle'),
    formError: $('#formError'),
    cancelEditBtn: $('#cancelEditBtn'),
    startTime: $('#startTime'),
    endTime: $('#endTime'),
    nowBtn: $('#nowBtn'),
    durationHint: $('#durationHint'),
    duration: $('#duration'),
    durationChips: document.querySelector('.duration-chips'),
    composer: $('#composer'),
    modeTimesBtn: $('#modeTimesBtn'),
    modeDurationBtn: $('#modeDurationBtn'),
    description: $('#description'),
    jiraKey: $('#jiraKey'),
    saveBtn: $('#saveBtn'),
    overlapHint: $('#overlapHint'),
    sortSelect: $('#sortSelect'),
    dateLabel: $('#dateLabel'),
    weekdayLabel: $('#weekdayLabel'),
    entryCount: $('#entryCount'),
    summaryLabel: $('#summaryLabel'),
    sumTotal: $('#sumTotal'),
    sumBarDone: $('#sumBarDone'),
    sumBarOpen: $('#sumBarOpen'),
    sumDone: $('#sumDone'),
    sumOpen: $('#sumOpen'),
    ticketList: $('#ticketList'),
    prevDayBtn: $('#prevDayBtn'),
    nextDayBtn: $('#nextDayBtn'),
    todayBtn: $('#todayBtn'),
    copyAllBtn: $('#copyAllBtn'),
    copyOpenBtn: $('#copyOpenBtn'),
    ledger: $('#ledger'),
    suggestList: $('#suggestList'),
    timerWarning: $('#timerWarning'),
    timerElapsed: $('#timerElapsed'),
    timerStartBtn: $('#timerStartBtn'),
    timerStartLabel: $('#timerStartLabel'),
    timerSurchargeNote: $('#timerSurchargeNote'),
    timerStopBtn: $('#timerStopBtn'),
    timerPauseBtn: $('#timerPauseBtn'),
    resumeBar: $('#resumeBar'),
    timerDiscardBtn: $('#timerDiscardBtn'),
  };

  function shiftDate(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // Dauer, Start und Ende haengen zusammen: Wird die Dauer eingegeben, berechnet sich das
  // Ende (oder bei fehlendem Start der Start); wird eine Uhrzeit geaendert, folgt die Dauer.
  const MAX_DURATION_MINUTES = 16 * 60; // wie auf dem Server
  const ENTRY_MODE_KEY = 'zeit.entryMode';
  function loadEntryMode() {
    try { return localStorage.getItem(ENTRY_MODE_KEY) === 'duration' ? 'duration' : 'times'; } catch { return 'times'; }
  }
  const formState = {
    mode: loadEntryMode(), // 'times': Start/Ende werden eingegeben, 'duration': die Dauer
    anchor: 'times', // 'duration': Dauer ist massgeblich, 'times': Start und Ende
    startIsDefault: true, // Start wurde noch nicht von Hand geaendert
    durationError: '',
  };

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
      text = 'Mit Zuschlag endet der Eintrag nach Mitternacht – bitte Zeit anpassen.';
      isError = true;
    } else if (formState.mode === 'times') {
      if (diff > 0) {
        const sur = currentSurcharge();
        text = sur > 0
          ? `= ${formatDurationLong(diff)} + ${sur} Min Zuschlag = ${formatDurationLong(diff + sur)}`
          : `= ${formatDurationLong(diff)}`;
      }
    } else if (diff > 0 && els.duration.value.trim()) {
      const sur = currentSurcharge();
      text = sur > 0 ? `${s} – ${e} Uhr + ${sur} Min Zuschlag → Ende ${effectiveEnd(e)}` : `${s} – ${e} Uhr`;
    } else if (s) {
      text = `Beginnt um ${s}, das Ende ergibt sich aus der Dauer.`;
    }
    els.durationHint.textContent = text || '\u00a0';
    els.durationHint.classList.toggle('is-error', isError);
  }

  function setEntryMode(mode, { focus } = {}) {
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

  /** Eintraege in der vom Nutzer gewaehlten Reihenfolge (state.entries bleibt chronologisch). */
  function sortedEntries() {
    return sortEntries(state.entries, state.sortMode);
  }

  /**
   * Zuschlag, der beim Speichern auf die Eingabe kommt. Beim Bearbeiten zeigt das Formular die
   * Zeit ohne den im Eintrag steckenden Zuschlag, der beim Speichern wieder aufgeschlagen wird.
   */
  function currentSurcharge() {
    return state.editingId ? state.editSurcharge : loadSurcharge();
  }

  /** Ende, wie es mit Zuschlag gespeichert wuerde ("HH:MM"), oder null, wenn es nach Mitternacht laege. */
  function effectiveEnd(end) {
    const total = hmToMinutes(end) + currentSurcharge();
    return total > 24 * 60 - 1 ? null : minutesToHM(total);
  }

  /** Warnt (ohne zu blockieren), wenn der Zeitraum einen anderen Eintrag des Tages ueberschneidet. */
  function updateOverlapHint() {
    const s = els.startTime.value;
    const e = els.endTime.value ? effectiveEnd(els.endTime.value) || els.endTime.value : '';
    let text = '';
    if (s && e && e > s) {
      const hits = state.entries.filter((x) => x.id !== state.editingId && x.startTime < e && s < x.endTime);
      if (hits.length > 0) {
        text = `⚠ Überschneidet sich mit ${hits.map((x) => `${x.startTime}–${x.endTime}`).join(', ')}.`;
      }
    }
    els.overlapHint.textContent = text;
  }

  function defaultStartTime() {
    if (state.entries.length === 0) {
      return isTodayISO(state.viewDate) ? nowHHMM() : '';
    }
    // Kette an das Ende des letzten (spaetesten) Eintrags des Tages an -
    // unabhaengig von der gewaehlten Anzeigereihenfolge.
    return state.entries.reduce((latest, e) => (e.endTime > latest ? e.endTime : latest), '');
  }

  function resetFormForNewEntry() {
    state.editingId = null;
    state.editSurcharge = 0;
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
    setFormError(els.formError, '');
    updateDurationHint();
  }

  function fillFormForEdit(entry) {
    state.editingId = entry.id;
    els.formTitle.textContent = 'Eintrag bearbeiten';
    els.saveBtn.textContent = 'Aktualisieren';
    els.cancelEditBtn.classList.remove('hidden');
    // Im Formular steht die Zeit ohne Zuschlag; er kommt beim Speichern wieder dazu. Ist der Eintrag
    // kuerzer als der Zuschlag (etwa vor dessen Einfuehrung angelegt), bleibt er unveraendert.
    const sur = loadSurcharge();
    state.editSurcharge = entry.durationMinutes > sur ? sur : 0;
    els.startTime.value = entry.startTime;
    els.endTime.value = minutesToHM(hmToMinutes(entry.endTime) - state.editSurcharge);
    formState.anchor = 'times';
    formState.startIsDefault = false;
    formState.durationError = '';
    syncDurationFromTimes();
    els.description.value = entry.description;
    els.jiraKey.value = entry.jiraKey || '';
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
    // Dauer uebernehmen: Start wie bei jedem neuen Eintrag (Ende des letzten bzw. jetzt),
    // das Ende ergibt sich aus der Dauer des Vorbilds.
    // Der Vorbild-Eintrag enthaelt den Zuschlag schon; er kommt beim Speichern wieder dazu.
    els.duration.value = formatDurationField(Math.max(1, entry.durationMinutes - loadSurcharge()));
    formState.anchor = 'duration';
    applyDuration();
    els.description.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast('Text, Ticket und Dauer übernommen – Zeiten prüfen.');
  }

  function entryRow(e) {
    const label = e.transferred ? 'In Jira eingetragen – Markierung entfernen' : 'Als in Jira eingetragen markieren';
    return `
      <div class="entry${e.transferred ? ' entry--done' : ''}" data-id="${e.id}">
        <div class="entry__time mono"><strong>${e.startTime}</strong>&ndash;${e.endTime}</div>
        <div class="entry__body">
          ${e.description
            ? `<div class="entry__desc">${escapeHtml(e.description)}</div>
          ${e.jiraKey ? `<div class="entry__meta"><span class="jira-tag">${escapeHtml(e.jiraKey)}</span></div>` : ''}`
            : `<div class="entry__desc mono">${escapeHtml(e.jiraKey || '')}</div>`}
        </div>
        <div class="entry__dur mono">${formatDurationLong(e.durationMinutes)}</div>
        <div class="entry__actions">
          <button type="button" class="icon-btn transfer-btn" aria-pressed="${e.transferred}" title="${label}" aria-label="${label}">
            <span class="transfer-dot">${ICONS.check}</span>
          </button>
          <button type="button" class="icon-btn repeat-btn" title="Nochmal erfassen (Text und Ticket übernehmen)" aria-label="Nochmal erfassen">${ICONS.repeat}</button>
          <button type="button" class="icon-btn copy-btn" title="Eintrag kopieren" aria-label="Eintrag kopieren">${ICONS.copy}</button>
          <button type="button" class="icon-btn edit-btn" title="Bearbeiten" aria-label="Eintrag bearbeiten">${ICONS.edit}</button>
          <button type="button" class="icon-btn delete-btn" title="Löschen" aria-label="Eintrag löschen">${ICONS.trash}</button>
        </div>
      </div>`;
  }

  function renderSummary() {
    const total = state.entries.reduce((sum, e) => sum + e.durationMinutes, 0);
    const done = state.entries.filter((e) => e.transferred).reduce((sum, e) => sum + e.durationMinutes, 0);
    const open = total - done;

    els.summaryLabel.textContent = isTodayISO(state.viewDate) ? 'Heute erfasst' : 'An diesem Tag erfasst';
    els.sumTotal.textContent = formatHM(total);
    els.sumDone.textContent = formatHM(done);
    els.sumOpen.textContent = formatHM(open);
    // Breite per CSSOM setzen (ein style-Attribut im HTML erlaubt die strikte CSP nicht)
    els.sumBarDone.style.width = total ? `${(done / total) * 100}%` : '0%';
    els.sumBarOpen.style.width = total ? `${(open / total) * 100}%` : '0%';

    // Summen je Ticket, laengste zuerst, "Ohne Ticket" ganz unten
    const byKey = new Map();
    for (const e of state.entries) {
      const key = e.jiraKey || '';
      byKey.set(key, (byKey.get(key) || 0) + e.durationMinutes);
    }
    const rows = [...byKey.entries()].sort((a, b) => (!a[0] - !b[0]) || b[1] - a[1]);
    els.ticketList.innerHTML = rows.length
      ? rows.map(([key, minutes]) => `
          <div class="ticket-row">
            ${key ? `<span class="mono ticket-row__key">${escapeHtml(key)}</span>` : '<span class="ticket-row__none">Ohne Ticket</span>'}
            <span class="mono">${formatHM(minutes)}</span>
          </div>`).join('')
      : '<div class="ticket-list--empty">Noch keine Einträge.</div>';
  }

  function renderLedger() {
    const parts = formatDateParts(state.viewDate);
    els.weekdayLabel.textContent = parts.weekday;
    els.dateLabel.textContent = parts.date;
    els.nowBtn.classList.toggle('hidden', !isTodayISO(state.viewDate));
    els.entryCount.textContent = state.entries.length ? `· ${state.entries.length}` : '';
    renderSummary();

    if (state.entries.length === 0) {
      els.ledger.innerHTML = '<div class="list-empty">Noch keine Einträge für diesen Tag.</div>';
      els.copyAllBtn.disabled = true;
      els.copyOpenBtn.disabled = true;
      els.copyOpenBtn.textContent = 'Offene kopieren';
      return;
    }

    els.copyAllBtn.disabled = false;
    const openCount = state.entries.filter((e) => !e.transferred).length;
    els.copyOpenBtn.disabled = openCount === 0;
    els.copyOpenBtn.textContent = openCount > 0 ? `Offene kopieren (${openCount})` : 'Offene kopieren';
    els.ledger.innerHTML = sortedEntries().map(entryRow).join('');
  }

  async function loadEntries() {
    const data = await Api.get(`/api/entries?date=${state.viewDate}`);
    state.entries = data.entries;
    renderLedger();
    if (!state.editingId) resetFormForNewEntry();
  }

  async function init() {
    setEntryMode(formState.mode);
    renderResumeBar();
    let me;
    try {
      me = await Api.get('/api/auth/me');
    } catch {
      return; // Api.get leitet bei 401 automatisch zu login.html um
    }
    els.userLabel.textContent = me.user.displayName;
    if (me.user.role === 'admin') els.adminNavLink.classList.remove('hidden');
    if (me.user.isApprentice) document.getElementById('weeklyNavLink').classList.remove('hidden');
    await Api.primeCsrf();
    await Promise.all([loadEntries(), loadTimer()]);
  }

  // --- Autovervollstaendigung ---------------------------------------

  /**
   * Haengt eine Vorschlagsliste an ein Textfeld. onApply(vorschlag) wird beim
   * Auswaehlen aufgerufen, nachdem der Text ins Feld uebernommen wurde.
   */
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
    }
  });

  // --- Timer ---------------------------------------------------------

  const BASE_TITLE = document.title;
  let elapsedInterval = null;

  function renderTimer(timer) {
    state.timer = timer;
    els.composer.classList.toggle('composer--timer', !!timer);
    renderResumeBar();
    els.formTitle.textContent = timer ? 'Timer läuft' : state.editingId ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
    clearInterval(elapsedInterval);

    document.title = BASE_TITLE;
    setFormError(els.timerWarning, '');
    if (!timer) {
      els.timerElapsed.textContent = '';
      return;
    }

    // Typische Fallen: Timer vergessen bzw. ueber Mitternacht gelaufen.
    const startedYesterdayOrEarlier = timer.workDate !== todayISO();
    els.timerStartLabel.textContent = timer.startTime;
    const sur = loadSurcharge();
    const carryMin = timer.carryMinutes || 0;
    els.timerSurchargeNote.textContent =
      (carryMin > 0 ? ` Enthält ${carryMin} Min vom unterbrochenen Teil.` : '') +
      (sur > 0 ? ` Beim Eintragen kommen ${sur} Min Zuschlag dazu.` : '');
    // Aufgabe und Ticket des Timers stehen in den normalen Formularfeldern.
    if (document.activeElement !== els.description) els.description.value = timer.description || '';
    if (document.activeElement !== els.jiraKey) els.jiraKey.value = timer.jiraKey || '';

    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(timer.startedAt).getTime()) / 1000));
      const shown = seconds + (timer.carryMinutes || 0) * 60; // Uhr zeigt die Gesamtzeit der Aufgabe
      const h = String(Math.floor(shown / 3600)).padStart(2, '0');
      const m = String(Math.floor((shown % 3600) / 60)).padStart(2, '0');
      const s2 = String(shown % 60).padStart(2, '0');
      els.timerElapsed.textContent = `${h}:${m}:${s2}`;
      document.title = `${h}:${m}:${s2} · ${BASE_TITLE}`;
      if (startedYesterdayOrEarlier) {
        els.timerWarning.innerHTML =
          '<div class="alert alert--error">Der Timer wurde an einem früheren Tag gestartet. ' +
          'Einträge über Mitternacht werden nicht unterstützt – bitte verwerfen und von Hand erfassen.</div>';
      } else if (seconds >= 10 * 3600) {
        els.timerWarning.innerHTML =
          '<div class="alert alert--error">Der Timer läuft seit über 10 Stunden – vergessen zu stoppen?</div>';
      }
    };
    tick();
    elapsedInterval = setInterval(tick, 1000);
  }

  async function loadTimer() {
    try {
      const data = await Api.get('/api/timer');
      renderTimer(data.timer);
    } catch { /* Timer ist optional - Seite funktioniert auch ohne */ }
  }

  // Timer starten: Aufgabe und Ticket aus dem Eintragsformular werden uebernommen.
  els.timerStartBtn.addEventListener('click', async () => {
    setFormError(els.formError, '');
    els.timerStartBtn.disabled = true;
    try {
      const data = await Api.post('/api/timer', {
        work_date: todayISO(),
        start_time: nowHHMM(),
        description: convertTicketLinks(els.description.value).trim(),
        jira_key: convertTicketLinks(els.jiraKey.value).trim().slice(0, 40) || null,
      });
      renderTimer(data.timer);
      showToast('Timer läuft – Aufgabe und Ticket lassen sich weiter bearbeiten.');
    } catch (err) {
      setFormError(els.formError, err.message);
    } finally {
      els.timerStartBtn.disabled = false;
    }
  });

  /** Aufgabe und Ticket des laufenden Timers speichern (ohne Timer: nichts zu tun). */
  async function saveTimerFields() {
    if (!state.timer) return;
    try {
      await Api.patch('/api/timer', {
        description: convertTicketLinks(els.description.value).trim(),
        jira_key: convertTicketLinks(els.jiraKey.value).trim().slice(0, 40),
      });
    } catch { /* wird spaetestens beim Stoppen mitgeschickt */ }
  }
  els.description.addEventListener('change', saveTimerFields);
  els.jiraKey.addEventListener('change', saveTimerFields);

  /** Timer beenden und als Eintrag speichern; mit pause wird die Aufgabe zum Weitermachen gemerkt. */
  async function stopTimer({ pause = false } = {}) {
    setFormError(els.formError, '');
    els.timerStopBtn.disabled = true;
    els.timerPauseBtn.disabled = true;
    const description = convertTicketLinks(els.description.value).trim();
    const jiraKey = convertTicketLinks(els.jiraKey.value).trim().slice(0, 40);
    try {
      // Zuschlag auf die gelaufene Zeit; nie ueber 23:59 hinaus
      const stopAt = Math.min(hmToMinutes(nowHHMM()) + loadSurcharge(), 24 * 60 - 1);
      const data = await Api.post('/api/timer/stop', {
        end_time: minutesToHM(stopAt),
        description,
        jira_key: jiraKey,
      });
      if (pause) {
        addPausedTask({
          description,
          jiraKey,
          entryId: data.entry.id,
          minutes: data.entry.durationMinutes,
          workDate: data.entry.workDate,
        });
      }
      renderTimer(null);
      els.description.value = '';
      els.jiraKey.value = '';
      state.viewDate = data.entry.workDate;
      await loadEntries();
      showToast(
        pause
          ? `Eintrag über ${formatDurationLong(data.entry.durationMinutes)} angelegt – „${description || jiraKey}" ist unterbrochen. Mit „Weitermachen" läuft die Zeit auf einem gemeinsamen Eintrag weiter.`
          : `Eintrag über ${formatDurationLong(data.entry.durationMinutes)} angelegt.`,
        pause ? { durationMs: 7000 } : undefined
      );
    } catch (err) {
      setFormError(els.formError, err.message);
    } finally {
      els.timerStopBtn.disabled = false;
      els.timerPauseBtn.disabled = false;
    }
  }
  els.timerStopBtn.addEventListener('click', () => stopTimer());
  els.timerPauseBtn.addEventListener('click', () => stopTimer({ pause: true }));

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

  function addPausedTask({ description, jiraKey, entryId, minutes, workDate }) {
    const rest = loadPausedTasks().filter((t) => !(t.description === description && (t.jiraKey || '') === (jiraKey || '')));
    savePausedTasks([{ description, jiraKey: jiraKey || '', entryId, minutes, workDate, at: Date.now() }, ...rest]);
  }

  function renderResumeBar() {
    const list = loadPausedTasks();
    els.resumeBar.classList.toggle('hidden', list.length === 0 || !!state.timer);
    els.resumeBar.innerHTML = list.length === 0 ? '' : `
      <span class="resume-bar__label">Weitermachen:</span>
      ${list.map((t, i) => `
        <span class="resume-item">
          <button type="button" class="chip chip--resume" data-index="${i}" title="${t.entryId && t.workDate === todayISO() ? `Timer weiterlaufen lassen – der bisherige Eintrag (${t.minutes} Min) wird mit dem neuen zusammengeführt` : 'Timer mit dieser Aufgabe starten'}">▶ ${escapeHtml(t.description || t.jiraKey)}${t.description && t.jiraKey ? `<span class="mono">${escapeHtml(t.jiraKey)}</span>` : ''}${t.entryId && t.workDate === todayISO() ? `<span class="mono">${t.minutes} Min bisher</span>` : ''}</button>
          <button type="button" class="chip-x" data-remove="${i}" aria-label="Aus der Liste entfernen" title="Aus der Liste entfernen">×</button>
        </span>`).join('')}`;
  }

  els.resumeBar.addEventListener('click', async (e) => {
    const list = loadPausedTasks();
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      list.splice(Number(removeBtn.dataset.remove), 1);
      return savePausedTasks(list);
    }
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
    const carry = canMerge ? Math.max(0, task.minutes - loadSurcharge()) : 0;
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

  els.timerDiscardBtn.addEventListener('click', async () => {
    if (!confirm('Timer verwerfen? Es wird kein Eintrag angelegt.')) return;
    try {
      await Api.del('/api/timer');
      renderTimer(null);
      els.description.value = '';
      els.jiraKey.value = '';
      resetFormForNewEntry();
    } catch (err) {
      setFormError(els.formError, err.message);
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

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError(els.formError, '');
    if (state.timer) return stopTimer(); // Strg+Enter beim laufenden Timer: stoppen und eintragen
    if (formState.durationError) return setFormError(els.formError, formState.durationError);
    if (!els.description.value.trim() && !convertTicketLinks(els.jiraKey.value).trim()) {
      return setFormError(els.formError, 'Bitte eine Aufgabe oder ein Ticket angeben.');
    }
    if (!els.startTime.value || !els.endTime.value) {
      return setFormError(els.formError, 'Bitte einen Zeitraum oder eine Dauer angeben.');
    }
    // Zuschlag nur bei neuen Eintraegen; beim Bearbeiten bleibt die Zeit, wie sie eingegeben wurde.
    const endWithSurcharge = effectiveEnd(els.endTime.value);
    if (!endWithSurcharge) {
      return setFormError(els.formError, 'Mit Zuschlag endet der Eintrag nach Mitternacht – bitte Zeit anpassen.');
    }
    const payload = {
      work_date: state.viewDate,
      start_time: els.startTime.value,
      end_time: endWithSurcharge,
      description: convertTicketLinks(els.description.value),
      jira_key: convertTicketLinks(els.jiraKey.value).trim().slice(0, 40) || null,
    };
    els.saveBtn.disabled = true;
    try {
      if (state.editingId) {
        await Api.put(`/api/entries/${state.editingId}`, payload);
        // Bearbeitung ist abgeschlossen - sonst bliebe die Maske im
        // Bearbeiten-Modus stehen, weil loadEntries() das Formular nur
        // zuruecksetzt, solange keine Bearbeitung laeuft.
        state.editingId = null;
        showToast('Eintrag aktualisiert.');
      } else {
        await Api.post('/api/entries', payload);
        showToast('Eintrag gespeichert.');
      }
      await loadEntries();
    } catch (err) {
      setFormError(els.formError, err.message);
    } finally {
      els.saveBtn.disabled = false;
    }
  });

  els.ledger.addEventListener('click', async (e) => {
    const row = e.target.closest('.entry');
    if (!row) return;
    const id = Number(row.dataset.id);
    const entry = state.entries.find((x) => x.id === id);
    if (!entry) return;

    if (state.timer && (e.target.closest('.repeat-btn') || e.target.closest('.edit-btn'))) {
      return showToast('Bitte zuerst den Timer stoppen oder verwerfen.');
    }
    if (e.target.closest('.copy-btn')) {
      const ok = await copyToClipboard(entryLine(entry, loadCopyTimes()));
      showToast(ok ? 'Eintrag kopiert.' : 'Kopieren fehlgeschlagen.');
    } else if (e.target.closest('.repeat-btn')) {
      startFromEntry(entry);
    } else if (e.target.closest('.edit-btn')) {
      fillFormForEdit(entry);
    } else if (e.target.closest('.transfer-btn')) {
      const next = !entry.transferred;
      try {
        await Api.patch(`/api/entries/${id}/transferred`, { transferred: next });
        entry.transferred = next;
        renderLedger();
      } catch (err) {
        showToast(err.message);
      }
    } else if (e.target.closest('.delete-btn')) {
      // Kein Nachfrage-Dialog mehr: der Eintrag wandert in den Papierkorb und
      // laesst sich 30 Sekunden lang per "Rueckgaengig" zurueckholen.
      try {
        await Api.del(`/api/entries/${id}`);
        if (state.editingId === id) resetFormForNewEntry();
        await loadEntries();
        showToast('Eintrag geloescht.', {
          label: 'Rückgängig',
          durationMs: 30000,
          onClick: async () => {
            try {
              await Api.post(`/api/entries/${id}/restore`);
              await loadEntries();
              showToast('Eintrag wiederhergestellt.');
            } catch (err) {
              showToast(err.message);
            }
          },
        });
      } catch (err) {
        showToast(err.message);
      }
    }
  });

  /**
   * Kopiert die uebergebenen Eintraege (in angezeigter Reihenfolge) samt Summe und
   * bietet danach an, die noch offenen davon als "in Jira eingetragen" zu markieren.
   */
  async function copyEntries(list, doneMessage) {
    if (list.length === 0) return;
    const withTimes = loadCopyTimes();
    const total = list.reduce((sum, e) => sum + e.durationMinutes, 0);
    const text = [
      ...list.map((e) => entryLine(e, withTimes)),
      '',
      `Gesamt: ${formatDurationLong(total)} (${total} Min)`,
    ].join('\n');
    const ok = await copyToClipboard(text);
    if (!ok) return showToast('Kopieren fehlgeschlagen.');

    const openIds = list.filter((e) => !e.transferred).map((e) => e.id);
    if (openIds.length === 0) return showToast(doneMessage);
    showToast(doneMessage, {
      label: 'Alle als „in Jira" markieren',
      durationMs: 15000,
      onClick: async () => {
        try {
          await Api.patch('/api/entries/transferred', { ids: openIds, transferred: true });
          state.entries.forEach((e) => { if (openIds.includes(e.id)) e.transferred = true; });
          renderLedger();
          showToast(`${openIds.length} Einträge als „in Jira eingetragen" markiert.`);
        } catch (err) {
          showToast(err.message);
        }
      },
    });
  }

  els.copyAllBtn.addEventListener('click', () => copyEntries(sortedEntries(), 'Tag kopiert.'));
  els.copyOpenBtn.addEventListener('click', () =>
    copyEntries(sortedEntries().filter((e) => !e.transferred), 'Offene Einträge kopiert.')
  );

  els.sortSelect.value = state.sortMode;
  els.sortSelect.addEventListener('change', () => {
    state.sortMode = els.sortSelect.value;
    saveSortMode(state.sortMode);
    renderLedger();
  });

  els.prevDayBtn.addEventListener('click', () => { state.viewDate = shiftDate(state.viewDate, -1); loadEntries(); });
  els.nextDayBtn.addEventListener('click', () => { state.viewDate = shiftDate(state.viewDate, 1); loadEntries(); });
  els.todayBtn.addEventListener('click', () => { state.viewDate = todayISO(); loadEntries(); });

  els.logoutBtn.addEventListener('click', async () => {
    try { await Api.post('/api/auth/logout'); } catch { /* egal, wir leiten trotzdem weiter */ }
    window.location.href = '/login.html';
  });

  init();
})();
