'use strict';

// Programm-Modus (lokaler Betrieb): meldet dem Server, dass das Fenster noch offen ist, damit er sich nach dem
// Schliessen beendet. Ausserhalb des Programm-Modus (Browser-Tab, Docker) antwortet der Server mit
// appMode:false bzw. 404 und diese Seite tut nichts. Dazu: der "Beenden"-Knopf unter Konto.
(function () {
  const ping = (state, keepalive) =>
    fetch(`/api/app/ping?state=${state}`, { credentials: 'same-origin', cache: 'no-store', keepalive: !!keepalive })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

  let timer = null;
  ping('open').then((data) => {
    if (!data || !data.appMode) return;
    timer = setInterval(() => ping('open'), 10000);
    // Seite wird verlassen (Fenster zu oder nur Seitenwechsel): die naechste Seite meldet sich sofort wieder
    window.addEventListener('pagehide', () => ping('closing', true));
    window.addEventListener('pageshow', (e) => { if (e.persisted) ping('open'); });
  });

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
