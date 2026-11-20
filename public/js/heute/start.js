'use strict';

// Start der Seite: Anmeldung prüfen, Daten laden, Aufgabenliste anbinden.
// Teil der Seite "Heute" (index.html); gemeinsamer Zustand in heute/kern.js, Start in heute/start.js.
(function () {
  const H = window.Heute;
  const { $, state, els, formState } = H;
  // aus anderen Teilen (erst beim Aufruf nachgeschlagen, weil die Dateien nacheinander laden)
  const { composeView, fitMini, loadEntries, loadTimer, renderResumeBar, setComposeView, setEntryMode, startTimerForTask } = H.later;

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
    await Api.primeCsrf();
    await Promise.all([loadEntries(), loadTimer()]);
  }


  // --- Autovervollstaendigung ---------------------------------------
  /**
   * Haengt eine Vorschlagsliste an ein Textfeld. onApply(vorschlag) wird beim
   * Auswaehlen aufgerufen, nachdem der Text ins Feld uebernommen wurde.
   */
  els.logoutBtn.addEventListener('click', async () => {
    try { await Api.post('/api/auth/logout'); } catch { /* egal, wir leiten trotzdem weiter */ }
    window.location.href = '/login.html';
  });


  setComposeView(composeView());
  if (window.ZeitTasks) window.ZeitTasks.init({ startTimer: startTimerForTask, running: () => state.timer });
  init().then(fitMini);

  Object.assign(H, { init });
})();
