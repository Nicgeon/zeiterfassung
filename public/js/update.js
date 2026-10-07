'use strict';

// Update-Hinweis fuer den lokalen Betrieb: zeigt oben einen Hinweis, wenn auf GitHub
// ein neuerer Stand vorliegt, und fragt, ob aktualisiert werden soll. Im Servermodus
// antwortet die API mit enabled:false, dann passiert hier nichts.
const ZeitUpdate = (() => {
  const DISMISS_KEY = 'zeit.updateDismissed';

  const status = () => Api.get('/api/update/status');
  const check = () => Api.post('/api/update/check');
  const apply = () => Api.post('/api/update/apply');

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isDismissed(sha) {
    try { return localStorage.getItem(DISMISS_KEY) === sha; } catch { return false; }
  }
  function dismiss(sha) {
    try { localStorage.setItem(DISMISS_KEY, sha); } catch { /* nur Komfort */ }
  }

  /** Wartet, bis die Anwendung nach dem Neustart wieder antwortet. */
  async function waitForRestart() {
    const started = Date.now();
    await sleep(1500);
    while (Date.now() - started < 90000) {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) return true;
      } catch { /* Server startet noch */ }
      await sleep(1000);
    }
    return false;
  }

  /** Installiert das Update; setMessage zeigt den Fortschritt an. */
  async function install(setMessage) {
    setMessage('Update wird heruntergeladen und geprüft …');
    const result = await apply();
    if (result.updated === 0) return setMessage('Bereits auf dem neuesten Stand.');
    if (!result.restart) {
      return setMessage('Update installiert. Bitte die Anwendung beenden und start-local erneut starten.');
    }
    setMessage('Update installiert – die Anwendung startet neu …');
    if (await waitForRestart()) window.location.reload();
    else setMessage('Der Neustart dauert länger als erwartet. Bitte start-local erneut starten.');
  }

  function describe(s) {
    const n = s.changedCount;
    const stand = s.latest ? ` · Stand ${s.latest.sha.slice(0, 7)}${s.latest.message ? `: „${s.latest.message}"` : ''}` : '';
    return `${n} ${n === 1 ? 'Datei' : 'Dateien'} geändert (Branch ${s.branch})${stand}`;
  }

  function showBanner(s) {
    const banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.setAttribute('role', 'status');

    const text = document.createElement('div');
    text.className = 'update-banner__text';
    const strong = document.createElement('strong');
    strong.textContent = 'Update verfügbar';
    const detail = document.createElement('span');
    detail.textContent = ` – ${describe(s)}. Jetzt aktualisieren?`;
    text.append(strong, detail);

    const actions = document.createElement('div');
    actions.className = 'update-banner__actions';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn btn--sm';
    yes.textContent = 'Jetzt aktualisieren';
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'btn btn--ghost btn--sm';
    later.textContent = 'Später';
    actions.append(yes, later);
    banner.append(text, actions);

    later.addEventListener('click', () => {
      if (s.latest) dismiss(s.latest.sha);
      banner.remove();
    });
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      later.classList.add('hidden');
      try {
        await install((message) => { text.textContent = message; });
      } catch (err) {
        text.textContent = `Update fehlgeschlagen: ${err.message}`;
        yes.disabled = false;
        later.classList.remove('hidden');
      }
    });

    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.insertAdjacentElement('afterend', banner);
    else document.body.prepend(banner);
  }

  async function init() {
    try {
      const s = await status();
      if (s.enabled && s.available && s.latest && !isDismissed(s.latest.sha)) showBanner(s);
    } catch { /* Update-Hinweis ist nur Komfort */ }
  }

  document.addEventListener('DOMContentLoaded', init);
  return { status, check, install, describe };
})();
