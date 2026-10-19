'use strict';

// Farbschema: "auto" folgt dem Betriebssystem, "light"/"dark"/"marine"/"marine-dark" erzwingen es.
// Die Wahl wird pro Browser gemerkt. Das Skript steht bewusst im <head>, damit
// das Schema gesetzt ist, bevor etwas gezeichnet wird (kein Aufblitzen).
(function () {
  const KEY = 'zeit.theme';
  const ORDER = ['auto', 'light', 'dark', 'marine', 'marine-dark'];
  const SVG = (paths) =>
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  const META = {
    auto: { icon: SVG('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'), label: 'Auto' },
    light: { icon: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>'), label: 'Hell' },
    dark: { icon: SVG('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>'), label: 'Dunkel' },
    marine: { icon: SVG('<path d="M3 9c3-3 6 3 9 0s6-3 9 0M3 15c3-3 6 3 9 0s6-3 9 0"/>'), label: 'Marine' },
    'marine-dark': { icon: SVG('<path d="M3 11c3-3 6 3 9 0s6-3 9 0M3 17c3-3 6 3 9 0s6-3 9 0"/><circle cx="17" cy="5" r="2" fill="currentColor"/>'), label: 'Marine dunkel' },
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

  // Uhrzeiten ausgeblendet? (gleiche Einstellung wie util.js/loadShowTimes, aber schon im <head>,
  // damit beim Laden nichts aufblitzt)
  try {
    const stored = localStorage.getItem('zeit.showTimes');
    const showTimes = stored === null ? localStorage.getItem('zeit.copyTimes') === '1' : stored === '1';
    document.documentElement.classList.toggle('no-times', !showTimes);
  } catch {
    document.documentElement.classList.add('no-times');
  }

  // Auswahlmenue statt Durchschalten: Knopf mit aktuellem Schema, darunter die Liste.
  document.addEventListener('DOMContentLoaded', () => {
    const wrap = document.createElement('div');
    wrap.className = 'theme-menu';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--ghost btn--sm theme-toggle';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');

    const list = document.createElement('div');
    list.className = 'theme-menu__list hidden';
    list.setAttribute('role', 'menu');
    list.setAttribute('aria-label', 'Farbschema');

    const items = ORDER.map((key) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'theme-menu__item';
      item.setAttribute('role', 'menuitemradio');
      item.dataset.theme = key;
      item.innerHTML = META[key].icon + '<span>' + META[key].label + '</span>' +
        '<svg class="theme-menu__check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
      list.appendChild(item);
      return item;
    });

    const render = () => {
      const m = META[mode];
      btn.innerHTML = m.icon + '<span class="theme-toggle__label">' + m.label + '</span>' +
        SVG('<path d="M6 9l6 6 6-6"/>').replace('width="18" height="18"', 'width="14" height="14"');
      btn.title = `Farbschema: ${m.label}`;
      btn.setAttribute('aria-label', btn.title);
      items.forEach((item) => item.setAttribute('aria-checked', String(item.dataset.theme === mode)));
    };
    render();

    const setOpen = (open) => {
      list.classList.toggle('hidden', !open);
      btn.setAttribute('aria-expanded', String(open));
    };
    const choose = (key) => {
      mode = key;
      try { localStorage.setItem(KEY, mode); } catch { /* nur Komfort */ }
      apply(mode);
      render();
      setOpen(false);
      btn.focus();
    };

    btn.addEventListener('click', () => {
      const open = list.classList.contains('hidden');
      setOpen(open);
      if (open) items[Math.max(0, ORDER.indexOf(mode))].focus();
    });
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.theme-menu__item');
      if (item) choose(item.dataset.theme);
    });
    list.addEventListener('keydown', (e) => {
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.focus(); }
      else if (e.key === 'Tab') setOpen(false);
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) setOpen(false); });

    wrap.append(btn, list);
    const host = document.querySelector('.topbar__user');
    if (host) {
      host.insertBefore(wrap, host.firstChild);
    } else {
      wrap.classList.add('theme-menu--floating');
      document.body.appendChild(wrap);
    }
  });
})();
