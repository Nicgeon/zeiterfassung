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

  // Seitenleiste: "expanded" (fest ausgeklappt), "hover" (Symbole, fährt beim Darüberfahren aus) oder "collapsed"
  // (nur Symbole). Gemerkt pro Browser; ohne Wahl ist sie auf Fenstern unter 1280 px im Modus "hover".
  const NAV_KEY = 'zeit.nav2';
  const NAV_MODES = ['expanded', 'hover', 'collapsed'];
  const navMode = () => {
    let saved = null;
    try { saved = localStorage.getItem(NAV_KEY); } catch { /* nur Komfort */ }
    return NAV_MODES.includes(saved) ? saved : window.innerWidth < 1280 ? 'hover' : 'expanded';
  };
  function applyNav(mode) {
    const root = document.documentElement;
    root.classList.toggle('nav-collapsed', mode !== 'expanded');
    root.classList.toggle('nav-hover', mode === 'hover');
    if (mode !== 'hover') root.classList.remove('nav-peek');
  }
  applyNav(navMode());

  // Auswahlmenue statt Durchschalten: Knopf mit aktuellem Schema, darunter die Liste.
  // Mini-Fenster (index.html?mini=1): nur Aufgabe und Zeit, siehe styles.css ".mini"
  if (/[?&]mini=1(&|$)/.test(location.search)) document.documentElement.classList.add('mini');

  const NAV_ICONS = {
    'index.html': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    'aufgaben.html': '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12.5l3 3 5-6"/>',
    'uebersicht.html': '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    'wochenbericht.html': '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7"/>',
    'account.html': '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8"/>',
    'admin.html': '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.2-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.4 3.6 5.2"/>',
    logout: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>',
    toggle: '<path d="M4 5h16v14H4z"/><path d="M9 5v14"/>',
  };
  const icon = (paths, cls) => '<svg class="' + (cls || 'nav-icon') + '" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';

  /** Symbole an den Menüpunkten, Ein-/Ausklappen, Anfangsbuchstabe als Profilbild (alles nur Darstellung). */
  function setupNav() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    bar.querySelectorAll('.topbar__nav a').forEach((a) => {
      const file = (a.getAttribute('href') || '').split('/').pop();
      let label = a.querySelector('.label');
      if (!label) {
        label = document.createElement('span');
        label.className = 'label';
        label.textContent = a.textContent.trim();
        a.textContent = '';
        a.appendChild(label);
      }
      a.title = label.textContent;
      if (NAV_ICONS[file] && !a.querySelector('.nav-icon')) a.insertAdjacentHTML('afterbegin', icon(NAV_ICONS[file]));
    });

    const brand = bar.querySelector('.topbar__brand');
    if (brand && !brand.querySelector('.nav-toggle')) {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'nav-toggle';
      t.innerHTML = icon(NAV_ICONS.toggle, 'nav-toggle__icon');
      const TITLES = {
        expanded: 'Menü: fest ausgeklappt – Klick: nur Symbole, fährt beim Darüberfahren aus',
        hover: 'Menü: fährt beim Darüberfahren aus – Klick: nur Symbole (ohne Ausfahren)',
        collapsed: 'Menü: nur Symbole – Klick: fest ausklappen',
      };
      const sync = () => {
        const mode = navMode();
        t.dataset.mode = mode;
        t.title = TITLES[mode];
        t.setAttribute('aria-label', t.title);
        t.setAttribute('aria-expanded', String(mode === 'expanded'));
      };
      t.addEventListener('click', () => {
        const next = NAV_MODES[(NAV_MODES.indexOf(navMode()) + 1) % NAV_MODES.length];
        try { localStorage.setItem(NAV_KEY, next); } catch { /* nur Komfort */ }
        applyNav(next);
        sync();
      });
      brand.appendChild(t);
      sync();
    }

    // Zähler am Menüpunkt "Aufgaben": überfällig + heute (still, wenn nicht angemeldet)
    const tasksLink = bar.querySelector('.topbar__nav a[href="/aufgaben.html"]');
    if (tasksLink && !document.documentElement.classList.contains('mini')) {
      fetch('/api/tasks', { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data || !Array.isArray(data.tasks)) return;
          const d = new Date();
          const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const n = data.tasks.filter((t) => t.dueDate && t.dueDate <= today).length;
          if (!n) return;
          const badge = document.createElement('span');
          badge.className = 'nav-badge';
          badge.textContent = n > 99 ? '99+' : String(n);
          badge.title = `${n} Aufgabe${n === 1 ? '' : 'n'} heute fällig oder überfällig`;
          tasksLink.appendChild(badge);
        })
        .catch(() => {});
    }

    // Ausfahren beim Darüberfahren (nur im Modus "hover"); bleibt offen, solange das Farbschema-Menü offen ist
    let peekTimer = null;
    const root = document.documentElement;
    const menuOpen = () => { const l = bar.querySelector('.theme-menu__list'); return !!l && !l.classList.contains('hidden'); };
    const peek = (on) => {
      clearTimeout(peekTimer);
      if (on) { if (root.classList.contains('nav-hover')) root.classList.add('nav-peek'); return; }
      peekTimer = setTimeout(() => { if (!menuOpen() && !bar.matches(':hover') && !bar.querySelector(':focus-visible')) root.classList.remove('nav-peek'); }, 200);
    };
    bar.addEventListener('mouseenter', () => peek(true));
    bar.addEventListener('mouseleave', () => peek(false));
    bar.addEventListener('focusin', () => peek(true));
    bar.addEventListener('focusout', () => peek(false));
    document.addEventListener('click', () => peek(false));

    const out = document.getElementById('logoutBtn');
    if (out && !out.querySelector('svg')) {
      const text = out.textContent.trim();
      out.title = text;
      out.innerHTML = icon(NAV_ICONS.logout, 'nav-icon') + '<span class="label">' + text + '</span>';
    }
    const who = document.getElementById('userLabel');
    if (who) {
      const initial = () => { who.dataset.initial = (who.textContent.trim()[0] || '·').toUpperCase(); who.title = who.textContent.trim(); };
      initial();
      new MutationObserver(initial).observe(who, { childList: true, characterData: true, subtree: true });
    }
  }

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

    setupNav();

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
