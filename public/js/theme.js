'use strict';

// Farbschema: "auto" folgt dem Betriebssystem, "light"/"dark" erzwingen es.
// Die Wahl wird pro Browser gemerkt. Das Skript steht bewusst im <head>, damit
// das Schema gesetzt ist, bevor etwas gezeichnet wird (kein Aufblitzen).
(function () {
  const KEY = 'zeit.theme';
  const ORDER = ['auto', 'light', 'dark'];
  const SVG = (paths) =>
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  const META = {
    auto: { icon: SVG('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'), label: 'Auto' },
    light: { icon: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>'), label: 'Hell' },
    dark: { icon: SVG('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>'), label: 'Dunkel' },
  };

  function load() {
    try {
      const saved = localStorage.getItem(KEY);
      if (ORDER.includes(saved)) return saved;
    } catch { /* localStorage nicht verfuegbar - Auto verwenden */ }
    return 'auto';
  }

  function apply(mode) {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
  }

  let mode = load();
  apply(mode);

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--ghost btn--sm theme-toggle';

    const render = () => {
      const m = META[mode];
      btn.innerHTML = m.icon;
      btn.title = `Farbschema: ${m.label} (Klick zum Wechseln)`;
      btn.setAttribute('aria-label', btn.title);
    };
    render();

    btn.addEventListener('click', () => {
      mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
      try { localStorage.setItem(KEY, mode); } catch { /* nur Komfort */ }
      apply(mode);
      render();
    });

    const host = document.querySelector('.topbar__user');
    if (host) {
      host.insertBefore(btn, host.firstChild);
    } else {
      btn.classList.add('theme-toggle--floating');
      document.body.appendChild(btn);
    }
  });
})();
