'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    viewDate: todayISO(),
    entries: [],
    editingId: null, // wenn gesetzt: Formular ist im Bearbeiten-Modus
    timer: null,
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
    description: $('#description'),
    jiraKey: $('#jiraKey'),
    saveBtn: $('#saveBtn'),
    dateLabel: $('#dateLabel'),
    prevDayBtn: $('#prevDayBtn'),
    nextDayBtn: $('#nextDayBtn'),
    todayBtn: $('#todayBtn'),
    copyAllBtn: $('#copyAllBtn'),
    ledger: $('#ledger'),
    ledgerTotal: $('#ledgerTotal'),
    ledgerTotalValue: $('#ledgerTotalValue'),
    suggestList: $('#suggestList'),
    timerError: $('#timerError'),
    timerElapsed: $('#timerElapsed'),
    timerIdleView: $('#timerIdleView'),
    timerRunningView: $('#timerRunningView'),
    timerDescription: $('#timerDescription'),
    timerStartBtn: $('#timerStartBtn'),
    timerStartLabel: $('#timerStartLabel'),
    timerRunningDescription: $('#timerRunningDescription'),
    timerRunningJira: $('#timerRunningJira'),
    timerStopBtn: $('#timerStopBtn'),
    timerDiscardBtn: $('#timerDiscardBtn'),
  };

  function shiftDate(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function updateDurationHint() {
    const s = els.startTime.value;
    const e = els.endTime.value;
    if (!s || !e) { els.durationHint.innerHTML = '&nbsp;'; return; }
    const [sh, sm] = s.split(':').map(Number);
    const [eh, em] = e.split(':').map(Number);
    const diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff <= 0) {
      els.durationHint.textContent = 'Ende muss nach dem Start liegen.';
      els.durationHint.classList.add('duration-hint--error');
    } else {
      els.durationHint.textContent = `→ ${formatDurationLong(diff)} (${diff} Min)`;
      els.durationHint.classList.remove('duration-hint--error');
    }
  }

  function defaultStartTime() {
    if (state.entries.length === 0) {
      return isTodayISO(state.viewDate) ? nowHHMM() : '';
    }
    // Kette an das Ende des letzten (spaetesten) Eintrags des Tages an.
    const last = state.entries[state.entries.length - 1];
    return last.endTime;
  }

  function resetFormForNewEntry() {
    state.editingId = null;
    els.formTitle.textContent = 'Neuer Eintrag';
    els.saveBtn.textContent = 'Eintrag speichern';
    els.cancelEditBtn.classList.add('hidden');
    els.startTime.value = defaultStartTime();
    els.endTime.value = isTodayISO(state.viewDate) ? nowHHMM() : '';
    els.description.value = '';
    els.jiraKey.value = '';
    setFormError(els.formError, '');
    updateDurationHint();
  }

  function fillFormForEdit(entry) {
    state.editingId = entry.id;
    els.formTitle.textContent = 'Eintrag bearbeiten';
    els.saveBtn.textContent = 'Aktualisieren';
    els.cancelEditBtn.classList.remove('hidden');
    els.startTime.value = entry.startTime;
    els.endTime.value = entry.endTime;
    els.description.value = entry.description;
    els.jiraKey.value = entry.jiraKey || '';
    setFormError(els.formError, '');
    updateDurationHint();
    els.description.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderLedger() {
    els.dateLabel.textContent = formatDateLong(state.viewDate);
    els.nowBtn.classList.toggle('hidden', !isTodayISO(state.viewDate));

    if (state.entries.length === 0) {
      els.ledger.innerHTML = '<div class="ledger-empty">Noch keine Eintraege fuer diesen Tag.</div>';
      els.ledgerTotal.classList.add('hidden');
      els.copyAllBtn.disabled = true;
      return;
    }

    els.copyAllBtn.disabled = false;
    els.ledger.innerHTML = state.entries.map((e) => `
      <div class="ledger-row${e.transferred ? ' ledger-row--transferred' : ''}" data-id="${e.id}">
        <div class="ledger-row__time mono"><strong>${e.startTime}</strong>&ndash;${e.endTime}<br>${formatDurationLong(e.durationMinutes)}</div>
        <div class="ledger-row__body">
          <div class="ledger-row__desc">${escapeHtml(e.description)}</div>
          <div class="ledger-row__meta">
            ${e.jiraKey ? `<span class="jira-tag">${escapeHtml(e.jiraKey)}</span>` : ''}
            <span>${formatDurationJira(e.durationMinutes)}</span>
            <label class="transfer-check">
              <input type="checkbox" class="transfer-box" ${e.transferred ? 'checked' : ''} />
              in Jira eingetragen
            </label>
          </div>
        </div>
        <div class="ledger-row__actions">
          <button type="button" class="btn btn--icon copy-btn" title="Eintrag kopieren">⧉</button>
          <button type="button" class="btn btn--icon edit-btn" title="Bearbeiten">✎</button>
          <button type="button" class="btn btn--icon delete-btn" title="Loeschen">🗑</button>
        </div>
      </div>
    `).join('');

    const total = state.entries.reduce((sum, e) => sum + e.durationMinutes, 0);
    const open = state.entries.filter((e) => !e.transferred).reduce((s2, e) => s2 + e.durationMinutes, 0);
    els.ledgerTotal.classList.remove('hidden');
    els.ledgerTotalValue.textContent =
      `${formatDurationLong(total)} (${total} Min)` +
      (open !== total ? ` · noch nicht in Jira: ${formatDurationLong(open)}` : '');
  }

  function entryLine(e) {
    return `${e.startTime}–${e.endTime} (${e.durationMinutes} Min) – ${e.description}${e.jiraKey ? ` [${e.jiraKey}]` : ''}`;
  }

  async function loadEntries() {
    const data = await Api.get(`/api/entries?date=${state.viewDate}`);
    state.entries = data.entries;
    renderLedger();
    if (!state.editingId) resetFormForNewEntry();
  }

  async function init() {
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

  let suggestTimer = null;
  let suggestions = [];

  function hideSuggestions() {
    els.suggestList.classList.add('hidden');
  }

  function renderSuggestions() {
    if (suggestions.length === 0) return hideSuggestions();
    els.suggestList.innerHTML = suggestions
      .map(
        (s, i) => `<li class="suggest-item" data-index="${i}">
            <span>${escapeHtml(s.description)}</span>
            ${s.jiraKey ? `<span class="jira-tag">${escapeHtml(s.jiraKey)}</span>` : ''}
          </li>`
      )
      .join('');
    els.suggestList.classList.remove('hidden');
  }

  async function fetchSuggestions() {
    const query = els.description.value.trim();
    // Mehrzeilige Texte sind meist fertig getippt - dann nicht vorschlagen.
    if (query.includes('\n')) return hideSuggestions();
    try {
      const data = await Api.get(`/api/entries/suggestions?q=${encodeURIComponent(query)}`);
      suggestions = data.suggestions.filter((s) => s.description !== query);
      renderSuggestions();
    } catch {
      hideSuggestions();
    }
  }

  function applySuggestion(index) {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    els.description.value = suggestion.description;
    if (suggestion.jiraKey && !els.jiraKey.value.trim()) els.jiraKey.value = suggestion.jiraKey;
    hideSuggestions();
    els.description.focus();
  }

  els.description.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(fetchSuggestions, 180);
  });
  els.description.addEventListener('focus', () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(fetchSuggestions, 120);
  });
  els.description.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideSuggestions();
  });
  els.suggestList.addEventListener('mousedown', (e) => {
    // mousedown statt click: sonst schliesst das blur-Ereignis die Liste zuerst
    const item = e.target.closest('.suggest-item');
    if (item) {
      e.preventDefault();
      applySuggestion(Number(item.dataset.index));
    }
  });
  els.description.addEventListener('blur', () => setTimeout(hideSuggestions, 120));

  // --- Timer ---------------------------------------------------------

  let elapsedInterval = null;

  function renderTimer(timer) {
    state.timer = timer;
    els.timerIdleView.classList.toggle('hidden', !!timer);
    els.timerRunningView.classList.toggle('hidden', !timer);
    clearInterval(elapsedInterval);

    if (!timer) {
      els.timerElapsed.textContent = '';
      return;
    }
    els.timerStartLabel.textContent = timer.startTime;
    if (document.activeElement !== els.timerRunningDescription) {
      els.timerRunningDescription.value = timer.description || '';
    }
    if (document.activeElement !== els.timerRunningJira) {
      els.timerRunningJira.value = timer.jiraKey || '';
    }

    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(timer.startedAt).getTime()) / 1000));
      const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
      const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
      const s2 = String(seconds % 60).padStart(2, '0');
      els.timerElapsed.textContent = `${h}:${m}:${s2}`;
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

  els.timerStartBtn.addEventListener('click', async () => {
    setFormError(els.timerError, '');
    try {
      const data = await Api.post('/api/timer', {
        work_date: todayISO(),
        start_time: nowHHMM(),
        description: els.timerDescription.value.trim(),
      });
      els.timerDescription.value = '';
      renderTimer(data.timer);
    } catch (err) {
      setFormError(els.timerError, err.message);
    }
  });

  async function saveTimerFields() {
    if (!state.timer) return;
    try {
      await Api.patch('/api/timer', {
        description: els.timerRunningDescription.value.trim(),
        jira_key: els.timerRunningJira.value.trim(),
      });
    } catch { /* wird spaetestens beim Stoppen mitgeschickt */ }
  }
  els.timerRunningDescription.addEventListener('change', saveTimerFields);
  els.timerRunningJira.addEventListener('change', saveTimerFields);

  els.timerStopBtn.addEventListener('click', async () => {
    setFormError(els.timerError, '');
    els.timerStopBtn.disabled = true;
    try {
      const data = await Api.post('/api/timer/stop', {
        end_time: nowHHMM(),
        description: els.timerRunningDescription.value.trim(),
        jira_key: els.timerRunningJira.value.trim(),
      });
      renderTimer(null);
      els.timerRunningDescription.value = '';
      els.timerRunningJira.value = '';
      state.viewDate = data.entry.workDate;
      await loadEntries();
      showToast(`Eintrag über ${formatDurationLong(data.entry.durationMinutes)} angelegt.`);
    } catch (err) {
      setFormError(els.timerError, err.message);
    } finally {
      els.timerStopBtn.disabled = false;
    }
  });

  els.timerDiscardBtn.addEventListener('click', async () => {
    if (!confirm('Timer verwerfen? Es wird kein Eintrag angelegt.')) return;
    try {
      await Api.del('/api/timer');
      renderTimer(null);
    } catch (err) {
      setFormError(els.timerError, err.message);
    }
  });

  // --- Events -------------------------------------------------------

  els.startTime.addEventListener('input', updateDurationHint);
  els.endTime.addEventListener('input', updateDurationHint);
  els.nowBtn.addEventListener('click', () => { els.endTime.value = nowHHMM(); updateDurationHint(); });

  els.cancelEditBtn.addEventListener('click', () => resetFormForNewEntry());

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormError(els.formError, '');
    const payload = {
      work_date: state.viewDate,
      start_time: els.startTime.value,
      end_time: els.endTime.value,
      description: els.description.value,
      jira_key: els.jiraKey.value.trim() || null,
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
    const row = e.target.closest('.ledger-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    const entry = state.entries.find((x) => x.id === id);
    if (!entry) return;

    if (e.target.closest('.copy-btn')) {
      const ok = await copyToClipboard(entryLine(entry));
      showToast(ok ? 'Eintrag kopiert.' : 'Kopieren fehlgeschlagen.');
    } else if (e.target.closest('.edit-btn')) {
      fillFormForEdit(entry);
    } else if (e.target.closest('.transfer-box')) {
      const box = e.target.closest('.transfer-box');
      const checked = box.checked;
      try {
        await Api.patch(`/api/entries/${id}/transferred`, { transferred: checked });
        entry.transferred = checked;
        renderLedger();
      } catch (err) {
        box.checked = !checked;
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

  els.copyAllBtn.addEventListener('click', async () => {
    if (state.entries.length === 0) return;
    const total = state.entries.reduce((sum, e) => sum + e.durationMinutes, 0);
    const text = [
      ...state.entries.map(entryLine),
      '',
      `Gesamt: ${formatDurationLong(total)} (${total} Min)`,
    ].join('\n');
    const ok = await copyToClipboard(text);
    showToast(ok ? 'Tag kopiert.' : 'Kopieren fehlgeschlagen.');
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
