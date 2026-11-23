'use strict';

// Gemeinsamer Zustand der Seite "Heute": geladene Einträge, Formularzustand, Elemente und kleine Rechenhilfen.
// Teil der Seite "Heute" (index.html); gemeinsamer Zustand in heute/kern.js, Start in heute/start.js.
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
    miniBtn: $('#miniBtn'),
    miniMainBtn: $('#miniMainBtn'),
    durationHint: $('#durationHint'),
    duration: $('#duration'),
    durationChips: document.querySelector('.duration-chips'),
    composer: $('#composer'),
    modeTimesBtn: $('#modeTimesBtn'),
    modeDurationBtn: $('#modeDurationBtn'),
    mergeBanner: $('#mergeBanner'),
    mergeText: $('#mergeText'),
    mergeCancelBtn: $('#mergeCancelBtn'),
    pauseEntryBtn: $('#pauseEntryBtn'),
    saveMenuBtn: $('#saveMenuBtn'),
    saveMenu: $('#saveMenu'),
    description: $('#description'),
    jiraKey: $('#jiraKey'),
    schoolDay: $('#schoolDay'),
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
    miniRecent: $('#miniRecent'),
    timerDiscardBtn: $('#timerDiscardBtn'),
  };

  const shiftDate = addDaysISO;

  // Dauer, Start und Ende haengen zusammen: Wird die Dauer eingegeben, berechnet sich das
  // Ende (oder bei fehlendem Start der Start); wird eine Uhrzeit geaendert, folgt die Dauer.
  const MAX_DURATION_MINUTES = 16 * 60; // wie auf dem Server
  const ENTRY_MODE_KEY = 'zeit.entryMode';
  function loadEntryMode() {
    // Ohne Uhrzeiten gibt es nur die Dauer-Eingabe.
    if (!loadShowTimes()) return 'duration';
    try { return localStorage.getItem(ENTRY_MODE_KEY) === 'duration' ? 'duration' : 'times'; } catch { return 'times'; }
  }
  const formState = {
    mode: loadEntryMode(), // 'times': Start/Ende werden eingegeben, 'duration': die Dauer
    anchor: 'times', // 'duration': Dauer ist massgeblich, 'times': Start und Ende
    startIsDefault: true, // Start wurde noch nicht von Hand geaendert
    durationError: '',
    merge: null, // { entryId, minutes, carry, label }: fruehere Zeit, die auf diesen Eintrag draufgelegt wird
    gapFill: false, // aus einer Luecke im Zeitstrahl: Start ist eine echte Uhrzeit
  };

  /** Eintraege in der vom Nutzer gewaehlten Reihenfolge (state.entries bleibt chronologisch). */
  function sortedEntries() {
    return sortEntries(state.entries, state.sortMode);
  }

  /**
   * Zuschlag, der beim Speichern auf die Eingabe kommt. Beim Bearbeiten zeigt das Formular die
   * Zeit ohne den im Eintrag steckenden Zuschlag, der beim Speichern wieder aufgeschlagen wird.
   */
  function surchargeBounds() {
    return state.editingId ? { min: state.editSurcharge, max: state.editSurcharge } : loadSurchargeRange();
  }

  /** Sicher aufgeschlagener Zuschlag (bei einem Bereich die Untergrenze). */
  function currentSurcharge() {
    return surchargeBounds().min;
  }

  /** "5 Min Zuschlag" bzw. "3–8 Min Zuschlag (zufällig)" */
  function describeSurcharge(range) {
    return `${formatSurchargeRange(range)} Min Zuschlag${surchargeIsRandom(range) ? ' (zufällig)' : ''}`;
  }

  /** Ende, wie es mit Zuschlag gespeichert wuerde ("HH:MM"), oder null, wenn es nach Mitternacht laege. */
  function effectiveEnd(end) {
    const total = hmToMinutes(end) + currentSurcharge();
    return total > 24 * 60 - 1 ? null : minutesToHM(total);
  }

  const renderedHtml = new WeakMap();
  function setHtml(el, html) {
    if (renderedHtml.get(el) === html) return;
    renderedHtml.set(el, html);
    el.innerHTML = html;
  }

  function typicalSurcharge() {
    const range = loadSurchargeRange();
    return Math.round((range.min + range.max) / 2);
  }


  const H = { $, state, els, formState, MAX_DURATION_MINUTES, ENTRY_MODE_KEY };
  // H.later.name(...) ruft H.name zur Aufrufzeit auf: Teile dürfen Funktionen späterer Dateien benutzen
  H.later = new Proxy({}, { get: (_, key) => (...args) => H[key](...args) });
  Object.assign(H, { currentSurcharge, describeSurcharge, effectiveEnd, loadEntryMode, setHtml, shiftDate, sortedEntries, surchargeBounds, typicalSurcharge });
  window.Heute = H;
})();
