'use strict';

// Farbschema: "auto" folgt dem Betriebssystem, "light"/"dark" erzwingen es.
// Die Wahl wird pro Browser gemerkt. Das Skript steht bewusst im <head>, damit
// das Schema gesetzt ist, bevor etwas gezeichnet wird (kein Aufblitzen).
(function () {
  const KEY = 'zeit.theme';
  const ORDER = ['auto', 'light', 'dark'];
  const META = {
    auto: { icon: '◐', label: 'Auto' },
    light: { icon: '☀', label: 'Hell' },
    dark: { icon: '☾', label: 'Dunkel' },
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
      btn.textContent = m.icon;
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
