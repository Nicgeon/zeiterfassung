'use strict';

// Der Tag: Zeitstrahl, Summen, Eintragsliste mit ihren Aktionen, Kopieren und Blättern zwischen Tagen.
// Teil der Seite "Heute" (index.html); gemeinsamer Zustand in heute/kern.js, Start in heute/start.js.
(function () {
  const H = window.Heute;
  const { $, state, els, formState } = H;
  // aus anderen Teilen (erst beim Aufruf nachgeschlagen, weil die Dateien nacheinander laden)
  const { fillFormForEdit, fillGap, renderMiniRecent, resetFormForNewEntry, setHtml, shiftDate, sortedEntries, startFromEntry } = H.later;

  /** Ende des letzten erfassten Zeitraums heute ("HH:MM") oder ''. */
  function lastEnd() {
    let last = '';
    for (const e of state.entries) {
      const end = e.segments ? e.segments[e.segments.length - 1][1] : loadShowTimes() ? e.endTime : '';
      if (end > last) last = end;
    }
    return last;
  }

  function renderSinceHint() {
    const el = document.getElementById('sinceHint');
    if (!el) return;
    let text = '';
    if (isTodayISO(state.viewDate) && !state.timer && !state.editingId) {
      const last = lastEnd();
      const gap = last ? hmToMinutes(nowHHMM()) - hmToMinutes(last) : 0;
      if (last && gap >= 10) text = `Letzter Eintrag endete um ${last} – seitdem ${formatDurationLong(gap)} ohne Eintrag.`;
    }
    el.textContent = text;
  }

  function renderTimeline() {
    if (!window.ZeitTimeline) return;
    window.ZeitTimeline.render(document.getElementById('timeline'), {
      entries: state.entries,
      timer: state.timer && state.timer.workDate === state.viewDate ? state.timer : null,
      showTimes: loadShowTimes(),
      isToday: isTodayISO(state.viewDate),
      now: nowHHMM(),
      onGap: fillGap,
    });
    renderSinceHint();
  }
  setInterval(renderTimeline, 60_000);

  function entryRow(e) {
    const label = e.transferred ? 'In Jira eingetragen – Markierung entfernen' : 'Als in Jira eingetragen markieren';
    return `
      <div class="entry${e.transferred ? ' entry--done' : ''}" data-id="${e.id}">
        <span class="entry__dot${e.transferred ? ' is-done' : ''}" aria-hidden="true"></span>
        <div class="entry__time mono"><strong>${e.startTime}</strong>&ndash;${e.endTime}</div>
        <div class="entry__body">
          ${e.description
            ? `<div class="entry__desc">${escapeHtml(e.description)}</div>
          ${e.jiraKey || e.school || (e.segments && e.segments.length > 1) ? `<div class="entry__meta">${e.jiraKey ? `<span class="jira-tag" data-jira-open="${escapeHtml(e.jiraKey)}">${escapeHtml(e.jiraKey)}</span>` : ''}${e.school ? '<span class="badge badge--school">Berufsschule</span>' : ''}${e.segments && e.segments.length > 1 ? `<span class="badge" title="${e.segments.map((p) => p.join('–')).join(', ')}">${e.segments.length} Teile</span>` : ''}</div>` : ''}`
            : `<div class="entry__desc mono">${escapeHtml(e.jiraKey || '')}</div>${e.school ? '<div class="entry__meta"><span class="badge badge--school">Berufsschule</span></div>' : ''}`}
        </div>
        <div class="entry__dur mono">${formatDurationLong(e.durationMinutes)}</div>
        <div class="entry__actions">
          <button type="button" class="icon-btn transfer-btn" aria-pressed="${e.transferred}" title="${label}" aria-label="${label}">
            <span class="transfer-dot">${ICONS.check}</span>
          </button>
          <button type="button" class="icon-btn school-btn" aria-pressed="${!!e.school}" title="${e.school ? 'Berufsschule-Markierung entfernen' : 'Als Berufsschule markieren (für den Berichtsheft-Text)'}" aria-label="Berufsschule markieren">${ICONS.school}</button>
          <button type="button" class="icon-btn repeat-btn" title="Nochmal erfassen (Text und Ticket übernehmen)" aria-label="Nochmal erfassen">${ICONS.repeat}</button>
          <button type="button" class="icon-btn jira-send-btn" title="${e.jiraComment ? `Steht als Kommentar in ${escapeHtml(e.jiraComment)} – erneut schreiben (aktualisiert ihn)` : 'Als internen Kommentar nach Jira schreiben'}" aria-label="Nach Jira schreiben">${ICONS.send}</button>
          <button type="button" class="icon-btn copy-btn" title="Eintrag kopieren" aria-label="Eintrag kopieren">${ICONS.copy}</button>
          <button type="button" class="icon-btn edit-btn" title="Bearbeiten" aria-label="Eintrag bearbeiten">${ICONS.edit}</button>
          <button type="button" class="icon-btn delete-btn" title="Löschen" aria-label="Eintrag löschen">${ICONS.trash}</button>
        </div>
      </div>`;
  }

  /**
   * innerHTML nur setzen, wenn sich etwas geaendert hat. Beim Zurueckkehren ins Fenster laeuft ein Abgleich
   * (Fokus-Ereignis), der die Listen neu zeichnet; wuerde dabei ein Knopf unter dem Mauszeiger ersetzt, ginge der
   * erste Klick (z. B. "Weitermachen") verloren.
   */
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
            ${key ? `<span class="mono ticket-row__key" data-jira-open="${escapeHtml(key)}">${escapeHtml(key)}</span>` : '<span class="ticket-row__none">Ohne Ticket</span>'}
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
    renderMiniRecent();
    renderTimeline();

    if (state.entries.length === 0) {
      setHtml(els.ledger, '<div class="list-empty">Noch keine Einträge für diesen Tag.</div>');
      els.copyAllBtn.disabled = true;
      els.copyOpenBtn.disabled = true;
      els.copyOpenBtn.textContent = 'Offene kopieren';
      return;
    }

    els.copyAllBtn.disabled = false;
    const openCount = state.entries.filter((e) => !e.transferred).length;
    els.copyOpenBtn.disabled = openCount === 0;
    els.copyOpenBtn.textContent = openCount > 0 ? `Offene kopieren (${openCount})` : 'Offene kopieren';
    const postOpen = document.getElementById('postOpenBtn');
    if (postOpen) {
      postOpen.disabled = openCount === 0;
      postOpen.textContent = openCount > 0 ? `Offene nach Jira (${openCount})` : 'Offene nach Jira';
    }
    setHtml(els.ledger, sortedEntries().map(entryRow).join(''));
  }

  async function loadEntries() {
    const data = await Api.get(`/api/entries?date=${state.viewDate}`);
    state.entries = data.entries;
    renderLedger();
    if (!state.editingId) resetFormForNewEntry();
  }

  els.ledger.addEventListener('click', async (e) => {
    const row = e.target.closest('.entry');
    if (!row) return;
    const id = Number(row.dataset.id);
    const entry = state.entries.find((x) => x.id === id);
    if (!entry) return;

    if (state.timer && (e.target.closest('.repeat-btn') || e.target.closest('.edit-btn'))) {
      return showToast('Bitte zuerst den Timer stoppen oder verwerfen.');
    }
    if (e.target.closest('.jira-send-btn')) {
      await postToJira([entry]);
    } else if (e.target.closest('.copy-btn')) {
      const ok = await copyToClipboard(entryLine(entry, loadShowTimes()));
      showToast(ok ? 'Eintrag kopiert.' : 'Kopieren fehlgeschlagen.');
    } else if (e.target.closest('.repeat-btn')) {
      startFromEntry(entry);
    } else if (e.target.closest('.edit-btn')) {
      fillFormForEdit(entry);
    } else if (e.target.closest('.school-btn')) {
      const next = !entry.school;
      try {
        await Api.patch(`/api/entries/${id}/school`, { school: next });
        entry.school = next;
        renderLedger();
      } catch (err) {
        showToast(err.message);
      }
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
        const res = await Api.del(`/api/entries/${id}`);
        if (state.editingId === id) resetFormForNewEntry();
        await loadEntries();
        const jiraNote = res.jira ? (res.jira.ok ? ' Der Kommentar in Jira ist entfernt.' : ` Der Kommentar in Jira konnte nicht entfernt werden: ${res.jira.error}`) : '';
        showToast(`Eintrag gelöscht.${jiraNote}`, {
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
   * Einträge als interne Kommentare nach Jira schreiben: ins eigene Ticket, ohne Ticket ins Tagesticket.
   * Mehrere Einträge erst nach Rückfrage (mit Übersicht, welches Ticket wie viele bekommt).
   */
  async function postToJira(list) {
    if (!list.length) return;
    if (list.length > 1) {
      const byKey = new Map();
      for (const e of list) { const k = e.jiraKey || 'Tagesticket'; byKey.set(k, (byKey.get(k) || 0) + 1); }
      const lines = [...byKey].map(([k, n]) => `${k}: ${n} Eintr${n === 1 ? 'ag' : 'äge'}`).join('\n');
      if (!window.confirm(`${list.length} Einträge als interne Kommentare nach Jira schreiben?\n\n${lines}`)) return;
    }
    try {
      const { results } = await Api.post('/api/jira/comments', { ids: list.map((e) => e.id), with_times: loadShowTimes() });
      await loadEntries();
      const ok = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      if (!failed.length) {
        showToast(ok.length === 1 ? `In ${ok[0].key} eingetragen${ok[0].daily ? ' (Tagesticket)' : ''}.` : `${ok.length} Einträge nach Jira geschrieben.`);
      } else {
        showToast(`${ok.length} geschrieben, ${failed.length} nicht: ${failed[0].error}`, { durationMs: 10000 });
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  /**
   * Kopiert die uebergebenen Eintraege (in angezeigter Reihenfolge, eine Zeile je Eintrag, ohne Summenzeile) und
   * bietet danach an, die noch offenen davon als "in Jira eingetragen" zu markieren.
   */
  async function copyEntries(list, doneMessage) {
    if (list.length === 0) return;
    const withTimes = loadShowTimes();
    const text = list.map((e) => entryLine(e, withTimes)).join('\n');
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
  const postOpenBtn = document.getElementById('postOpenBtn');
  if (postOpenBtn) postOpenBtn.addEventListener('click', () => postToJira(sortedEntries().filter((e) => !e.transferred)));
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


  Object.assign(H, { copyEntries, entryRow, lastEnd, loadEntries, renderLedger, renderSinceHint, renderSummary, renderTimeline });
})();
