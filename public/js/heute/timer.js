'use strict';

// Timer: anzeigen, starten (auch aus einer Aufgabe), unterbrechen, stoppen, verwerfen; danach ggf. fragen, ob die Aufgabe erledigt ist.
// Teil der Seite "Heute" (index.html); gemeinsamer Zustand in heute/kern.js, Start in heute/start.js.
(function () {
  const H = window.Heute;
  const { $, state, els, formState } = H;
  // aus anderen Teilen (erst beim Aufruf nachgeschlagen, weil die Dateien nacheinander laden)
  const { addPausedTask, autoCopyEntry, describeSurcharge, loadEntries, renderResumeBar, renderTimeline, resetFormForNewEntry } = H.later;

  // --- Timer ---------------------------------------------------------
  const BASE_TITLE = document.title;
  let elapsedInterval = null;

  function renderTimer(timer) {
    state.timer = timer;
    els.composer.classList.toggle('composer--timer', !!timer);
    renderResumeBar();
    if (window.ZeitTasks) window.ZeitTasks.render();
    renderTimeline();
    els.formTitle.textContent = timer ? 'Timer läuft' : state.editingId ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
    // Timer aus einer Aufgabe: deren Titel steht nur als Hinweis im Feld, beschrieben wird die erledigte Arbeit
    els.description.placeholder = timer && timer.taskTitle
      ? `Was hast du an „${timer.taskTitle}“ gemacht?`
      : 'Was hast du gemacht? (oder nur ein Ticket angeben)';
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
    const range = loadSurchargeRange();
    const carryMin = timer.carryMinutes || 0;
    els.timerSurchargeNote.textContent =
      (carryMin > 0 ? ` Enthält ${carryMin} Min vom unterbrochenen Teil.` : '') +
      (range.max > 0 ? ` Beim Eintragen kommen ${describeSurcharge(range)} dazu.` : '');
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
      const nowMin = hmToMinutes(nowHHMM());
      const surcharge = Math.max(0, Math.min(rollSurcharge(), 24 * 60 - 1 - nowMin));
      const data = await Api.post('/api/timer/stop', {
        end_time: minutesToHM(nowMin + surcharge),
        real_end_time: minutesToHM(nowMin), // echte Uhrzeit ohne Zuschlag: für den Zeitstrahl
        description,
        jira_key: jiraKey,
      });
      if (pause) {
        addPausedTask({
          description: description || data.entry.description || '',
          jiraKey,
          entryId: data.entry.id,
          minutes: data.entry.durationMinutes,
          workDate: data.entry.workDate,
          surcharge,
        });
      }
      renderTimer(null);
      els.description.value = '';
      els.jiraKey.value = '';
      state.viewDate = data.entry.workDate;
      await loadEntries();
      const copied = await autoCopyEntry(data.entry);
      const done = `Eintrag über ${formatDurationLong(data.entry.durationMinutes)} angelegt.${copied}`;
      // Lief der Timer für eine Aufgabe, fragen, ob sie damit erledigt ist (abgehakt wird nie ungefragt)
      const task = !pause && data.entry.taskId ? await openTask(data.entry.taskId) : null;
      if (task) askTaskDone(task, done);
      else showToast(
        pause
          ? `Eintrag über ${formatDurationLong(data.entry.durationMinutes)} angelegt – „${description || jiraKey}" ist unterbrochen. Mit „Weitermachen" läuft die Zeit auf einem gemeinsamen Eintrag weiter.${copied}`
          : done,
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


  /** Aus der Aufgabenliste: Timer mit Titel und Ticket der Aufgabe starten (die Aufgabe bleibt offen). */
  async function startTimerForTask(task) {
    if (state.timer) { showToast('Bitte zuerst den Timer stoppen oder unterbrechen.'); return; }
    setFormError(els.formError, '');
    try {
      const data = await Api.post('/api/timer', {
        work_date: todayISO(),
        start_time: nowHHMM(),
        description: '', // beschrieben wird, was man getan hat - nicht der Titel der Aufgabe (der steht als Hinweis im Feld)
        jira_key: task.jiraKey || null,
        task_id: task.id, // die erfasste Zeit zählt zur Aufgabe
      });
      renderTimer(data.timer);
    } catch (err) {
      showToast(err.message);
    }
  }

  /** Offene Aufgabe zu einer id (null, wenn erledigt, gelöscht oder nicht ladbar). */
  async function openTask(id) {
    try {
      const data = await Api.get('/api/tasks');
      return data.tasks.find((t) => t.id === id) || null;
    } catch { return null; }
  }

  /** Nach dem Stoppen: "Ist die Aufgabe erledigt?" mit Knopf zum Abhaken (und Rückgängig danach). */
  function askTaskDone(task, lead) {
    const name = task.title || task.jiraKey || 'die Aufgabe';
    showToast(`${lead} Ist „${name}“ damit erledigt?`, {
      label: 'Ja, abhaken',
      durationMs: 15000,
      onClick: async () => {
        try {
          const r = await Api.patch(`/api/tasks/${task.id}/done`, { done: true });
          if (window.ZeitTasks) window.ZeitTasks.refresh();
          showToast(r.next ? `„${name}“ erledigt – die nächste Wiederholung ist angelegt.` : `„${name}“ erledigt.`, {
            label: 'Rückgängig',
            durationMs: 8000,
            onClick: async () => {
              try {
                await Api.patch(`/api/tasks/${task.id}/done`, { done: false });
                if (r.next) await Api.del(`/api/tasks/${r.next.id}`);
                if (window.ZeitTasks) window.ZeitTasks.refresh();
              } catch (err) { showToast(err.message); }
            },
          });
        } catch (err) {
          showToast(err.message);
        }
      },
    });
  }

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



  Object.assign(H, { askTaskDone, loadTimer, openTask, renderTimer, saveTimerFields, startTimerForTask, stopTimer });
})();
