'use strict';

// Programm-Modus (lokaler Betrieb): meldet dem Server, dass das Fenster noch offen ist, damit er sich nach dem
// Schliessen beendet. Ausserhalb des Programm-Modus (Browser-Tab, Docker) antwortet der Server mit
// appMode:false bzw. 404 und diese Seite tut nichts. Dazu: der "Beenden"-Knopf unter Konto.
(function () {
  const ping = (state, keepalive, load) =>
    fetch(`/api/app/ping?state=${state}${load ? '&load=1' : ''}`, { credentials: 'same-origin', cache: 'no-store', keepalive: !!keepalive })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

  let timer = null;
  // load=1: die Seite ist gerade geladen – daran erkennt der Starter, dass sein Fenster wirklich zu sehen ist
  ping('open', false, true).then((data) => {
    if (!data || !data.appMode) return;
    window.zeitAppMode = true;
    timer = setInterval(() => ping('open'), 10000);
    // Seite wird verlassen (Fenster zu oder nur Seitenwechsel): die naechste Seite meldet sich sofort wieder
    window.addEventListener('pagehide', () => ping('closing', true));
    window.addEventListener('pageshow', (e) => { if (e.persisted) ping('open'); });
  });

  // Browser fuer das Programmfenster (Konto -> Programm)
  const browserSelect = document.getElementById('browserSelect');
  if (browserSelect) {
    const names = { edge: 'Microsoft Edge', chrome: 'Google Chrome', brave: 'Brave', chromium: 'Chromium' };
    const hint = document.getElementById('browserHint');
    const backgroundCheck = document.getElementById('backgroundCheck');
    const autostartCheck = document.getElementById('autostartCheck');
    Api.get('/api/app/settings').then((s) => {
      browserSelect.value = s.browser;
      if (backgroundCheck) backgroundCheck.checked = !!s.background;
      if (autostartCheck) {
        autostartCheck.checked = !!s.autostart;
        if (!s.autostartSupported) {
          autostartCheck.disabled = true;
          document.getElementById('autostartHint').textContent = 'Auf diesem System nicht verfügbar.';
        }
      }
      // Hinweis, wenn die installierte Node.js-Version bekannte Sicherheitslücken hat
      const nodeBox = document.getElementById('nodeHint');
      if (nodeBox && s.node) {
        nodeBox.classList.remove('hidden');
        nodeBox.innerHTML = s.node.outdated
          ? `<div class="alert alert--error">${escapeHtml(s.node.text)} Download: nodejs.org (für Windows ohne Administratorrechte das ZIP-Archiv in den Benutzerordner entpacken, z. B. C:\\Users\\NAME\\node-v${escapeHtml(s.node.recommended || '')}-win-x64). Danach die Zeiterfassung einmal beenden und neu starten.</div>`
          : `<p class="field-hint">Node.js ${escapeHtml(s.node.version)} – aktuell, keine bekannten Sicherheitslücken.</p>`;
      }
      const cur = s.current;
      hint.textContent = 'Gilt ab dem nächsten Start des Programms. ' +
        (cur && cur.exe ? `Aktuell in Benutzung: ${names[cur.kind] || 'Browser'} (${cur.exe}).` : 'Derzeit läuft kein Programmfenster dieser Sitzung (oder es wurde ein Browser-Tab verwendet).');
    }).catch(() => {});
    browserSelect.addEventListener('change', async () => {
      try {
        await Api.put('/api/app/settings', { browser: browserSelect.value });
        showToast('Gespeichert – gilt ab dem nächsten Start.');
      } catch (err) { showToast(err.message); }
    });
  }

  const saveSetting = async (body, box, apply) => {
    try {
      const r = await Api.put('/api/app/settings', body);
      apply(r);
      showToast('Gespeichert.');
    } catch (err) {
      box.checked = !box.checked;
      showToast(err.message);
    }
  };
  const bgBox = document.getElementById('backgroundCheck');
  const autoBox = document.getElementById('autostartCheck');
  if (bgBox) {
    bgBox.addEventListener('change', () => saveSetting({ background: bgBox.checked }, bgBox, (r) => { bgBox.checked = !!r.background; if (autoBox) autoBox.checked = !!r.autostart; }));
  }
  if (autoBox) {
    autoBox.addEventListener('change', () => saveSetting({ autostart: autoBox.checked }, autoBox, (r) => { autoBox.checked = !!r.autostart; if (bgBox) bgBox.checked = !!r.background; }));
  }

  const openInBrowserBtn = document.getElementById('openInBrowserBtn');
  const localUrl = document.getElementById('localUrl');
  if (localUrl) localUrl.textContent = window.location.origin;
  if (openInBrowserBtn) {
    openInBrowserBtn.addEventListener('click', async () => {
      try {
        const r = await Api.post('/api/app/open-in-browser');
        showToast(r && r.opened ? 'Im Standardbrowser geöffnet.' : 'Der Standardbrowser ließ sich nicht öffnen.');
      } catch (err) {
        showToast(err.message);
      }
    });
  }

  const quitBtn = document.getElementById('quitBtn');
  if (quitBtn) {
    quitBtn.addEventListener('click', async () => {
      quitBtn.disabled = true;
      try {
        await Api.post('/api/app/quit');
        if (timer) clearInterval(timer);
        document.body.innerHTML = '<div class="shell"><div class="card"><h2>Zeiterfassung wurde beendet</h2><p class="text-muted">Dieses Fenster kann geschlossen werden. Zum erneuten Starten das Programm wieder öffnen.</p></div></div>';
        setTimeout(() => window.close(), 300);
      } catch (err) {
        quitBtn.disabled = false;
        showToast(err.message);
      }
    });
  }
})();
