'use strict';

// Einstellungen in Unterreitern: jede Karte gehört über data-tab zu einem Bereich. Bereiche ohne sichtbare Karte
// (z. B. "Sicherheit" im lokalen Betrieb, "Programm" auf dem Server) werden ausgeblendet. Der Bereich steht in der
// Adresse (#jira usw.), damit er sich verlinken lässt.
(function () {
  const tabsEl = document.getElementById('stTabs');
  if (!tabsEl) return;
  const TABS = [
    { id: 'allgemein', label: 'Allgemein', hint: 'Uhrzeiten, Zuschlag, Azubi', lead: 'Wie die Zeiterfassung Zeiten aufnimmt und anzeigt.' },
    { id: 'erinnerungen', label: 'Erinnerungen', hint: 'Timer, Lücken, Feierabend', lead: 'Benachrichtigungen, damit keine Zeit verloren geht.' },
    { id: 'programm', label: 'Programm & Updates', hint: 'Browser, Hintergrund, Autostart', lead: 'Das Programmfenster auf diesem Rechner, Hintergrundbetrieb und Updates.' },
    { id: 'jira', label: 'Jira', hint: 'Tickets, Kommentare, Abgleich', lead: 'Titel nachladen, eigene Tickets holen, Tickets öffnen, Aufgaben abgleichen und auf Wunsch Einträge als interne Kommentare schreiben.' },
    { id: 'ki', label: 'Berichtsheft-KI', hint: 'Anbieter, Namenslisten', lead: 'KI-Anbieter und Anonymisierung für den Berichtsheft-Text.' },
    { id: 'sicherheit', label: 'Sicherheit', hint: 'Passwort, 2FA, Passkeys', lead: 'Anmeldung und Schutz deines Kontos.' },
    { id: 'daten', label: 'Daten', hint: 'Sicherung, Export, Import', lead: 'Deine Daten sichern und übernehmen.' },
  ];
  const cards = [...document.querySelectorAll('[data-tab]')];
  let current = null; // angezeigter Bereich
  let wanted = null; // gewünschter Bereich (aus der Adresse); kann erst nach der Anmeldeprüfung sichtbar werden

  // Sichtbar = nicht durch Betriebsart (local-only/local-hide) ausgeblendet
  const available = (tab) => cards.some((c) => c.dataset.tab === tab.id && !(
    (c.classList.contains('local-only') && !document.body.classList.contains('local-mode')) ||
    (c.classList.contains('local-hide') && document.body.classList.contains('local-mode'))));

  function render() {
    const tabs = TABS.filter(available);
    current = tabs.some((t) => t.id === wanted) ? wanted : tabs.length ? tabs[0].id : null;
    tabsEl.innerHTML = tabs.map((t) => `
      <button type="button" role="tab" class="st-tab${t.id === current ? ' is-active' : ''}" aria-selected="${t.id === current}" data-tab-id="${t.id}">
        <span class="st-tab__label">${t.label}</span><span class="st-tab__hint">${t.hint}</span>
      </button>`).join('');
    cards.forEach((c) => c.classList.toggle('st-hidden', c.dataset.tab !== current));
    const t = TABS.find((x) => x.id === current);
    document.getElementById('stHeading').textContent = t ? t.label : '';
    document.getElementById('stLead').textContent = t ? t.lead : '';
  }

  function select(id, push) {
    wanted = id;
    render();
    if (push) history.replaceState(null, '', `#${id}`);
    window.scrollTo({ top: 0 });
  }

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab-id]');
    if (b) select(b.dataset.tabId, true);
  });
  window.addEventListener('hashchange', () => select(location.hash.slice(1), false));

  wanted = location.hash.slice(1) || 'allgemein';
  render();
  // Die Betriebsart steht erst nach der Anmeldeprüfung fest (body.local-mode): dann neu sortieren
  new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();
