'use strict';

// Gemeinsame Bausteine für Aufgaben: Datumsrechnung, Texte zu Fälligkeit und Wiederholung, Symbole, Eingabe
// "Titel + Ticketnummer" auswerten sowie Abhaken und Löschen mit Rückgängig. Benutzt von der Aufgabenliste auf
// "Heute"/im Mini-Fenster (tasks.js) und von der Seite "Aufgaben" (aufgaben.js).
(function () {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parts = (dateStr) => dateStr.split('-').map(Number);

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  /** Ticketnummer wie ITPKK-123 irgendwo im Text. */
  const KEY_RE = /\b[A-Z][A-Z0-9_]+-\d+\b/;

  // --- Datum -----------------------------------------------------------------------------------------------
  function addDays(dateStr, days) {
    const [y, m, d] = parts(dateStr);
    return iso(new Date(y, m - 1, d + days));
  }
  function nextMonday(dateStr) {
    const [y, m, d] = parts(dateStr);
    const weekday = (new Date(y, m - 1, d).getDay() + 6) % 7; // Mo = 0
    return addDays(dateStr, 7 - weekday);
  }
  /** Monate addieren; der Tag wird aufs Monatsende gekürzt (31. Jan + 1 Monat = 28./29. Feb). */
  function addMonths(dateStr, months) {
    const [y, m, d] = parts(dateStr);
    const total = y * 12 + (m - 1) + months;
    const year = Math.floor(total / 12);
    const month = total % 12;
    return `${year}-${pad(month + 1)}-${pad(Math.min(d, new Date(year, month + 1, 0).getDate()))}`;
  }
  /** "Fr 20.11." */
  function dayLabel(dateStr) {
    const [y, m, d] = parts(dateStr);
    return new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace(',', '');
  }

  /**
   * Datum zur Schnellwahl ("today", "tomorrow", "dayafter", "monday", "week", "month", "custom", "none").
   * null = ohne Datum; undefined = "custom" ohne eingegebenes Datum.
   */
  function dateForChoice(choice, customDate) {
    const today = todayISO();
    switch (choice) {
      case 'today': return today;
      case 'tomorrow': return addDays(today, 1);
      case 'dayafter': return addDays(today, 2);
      case 'monday': return nextMonday(today);
      case 'week': return addDays(today, 7);
      case 'month': return addMonths(today, 1);
      case 'custom': return customDate || undefined;
      default: return null;
    }
  }

  // --- Texte ------------------------------------------------------------------------------------------------
  /** "überfällig seit Mi 18.11.", "heute 14:00", "morgen", "Fr 27.11. 09:30" */
  function dueText(task, today = todayISO()) {
    if (!task.dueDate) return '';
    const time = task.dueTime ? ` ${task.dueTime}` : '';
    if (task.dueDate < today) return `überfällig seit ${dayLabel(task.dueDate)}`;
    if (task.dueDate === today) return task.dueTime ? `heute ${task.dueTime}` : 'heute';
    if (task.dueDate === addDays(today, 1)) return `morgen${time}`;
    return `${dayLabel(task.dueDate)}${time}`;
  }
  /** "wöchentlich", "alle 2 Wochen" */
  function repeatText(repeat) {
    if (!repeat) return '';
    if (repeat.every === 1) return { day: 'täglich', week: 'wöchentlich', month: 'monatlich' }[repeat.unit];
    return `alle ${repeat.every} ${{ day: 'Tage', week: 'Wochen', month: 'Monate' }[repeat.unit]}`;
  }
  /** Minuten als "3:05" */
  const hm = (minutes) => `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;

  // --- Eingabe "Neue Aufgabe" ---------------------------------------------------------------------------
  /**
   * Text aus dem Eingabefeld zerlegen: eine Ticketnummer (auch aus einem eingefügten Jira-Link) wird zum Ticket,
   * der Rest zum Titel. Steht nur die Nummer da, kommt der Titel aus Jira (falls eingerichtet).
   * @returns {Promise<{title: string, key: string|null}|null>} null bei leerer Eingabe
   */
  async function parseQuickInput(text) {
    const raw = convertTicketLinks(String(text || '')).trim();
    if (!raw) return null;
    const key = (raw.match(KEY_RE) || [null])[0];
    let title = key ? raw.replace(key, '').replace(/\s{2,}/g, ' ').replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, '') : raw;
    if (!title && key && window.ZeitJira) {
      const issue = await window.ZeitJira.issue(key);
      if (issue && issue.summary) title = issue.summary;
    }
    return { title, key };
  }

  // --- Abhaken und Löschen mit Rückgängig -------------------------------------------------------------
  /**
   * Abhaken bzw. wieder öffnen. Bei einer Wiederholung legt der Server die nächste Aufgabe an; "Rückgängig"
   * öffnet die erledigte wieder und entfernt diese nächste. reload() lädt die Liste neu.
   * @returns {Promise<object|null>} Antwort des Servers ({task, next}) oder null bei Fehler
   */
  async function setDone(id, done, reload) {
    try {
      const data = await Api.patch(`/api/tasks/${id}/done`, { done });
      await reload();
      if (!done) return data;
      const msg = data.next ? `Erledigt. Nächste: ${dueText(data.next)}.` : 'Aufgabe erledigt.';
      showToast(msg, {
        label: 'Rückgängig',
        durationMs: 8000,
        onClick: async () => {
          try {
            await Api.patch(`/api/tasks/${id}/done`, { done: false });
            if (data.next) await Api.del(`/api/tasks/${data.next.id}`);
            await reload();
          } catch (err) { showToast(err.message); }
        },
      });
      return data;
    } catch (err) {
      showToast(err.message);
      return null;
    }
  }

  /** Löschen (Papierkorb, 30 Sekunden lang rückgängig zu machen). */
  async function remove(id, reload) {
    try {
      await Api.del(`/api/tasks/${id}`);
      await reload();
      showToast('Aufgabe gelöscht.', {
        label: 'Rückgängig',
        durationMs: 30000,
        onClick: async () => {
          try { await Api.post(`/api/tasks/${id}/restore`); await reload(); } catch (err) { showToast(err.message); }
        },
      });
      return true;
    } catch (err) {
      showToast(err.message);
      return false;
    }
  }

  /** innerHTML nur setzen, wenn sich etwas geändert hat (sonst geht ein Klick während eines Abgleichs verloren). */
  function htmlSetter() {
    const rendered = new WeakMap();
    return (node, html) => {
      if (rendered.get(node) === html) return;
      rendered.set(node, html);
      node.innerHTML = html;
    };
  }

  window.AufgabenHilfe = {
    ICON, KEY_RE, addDays, nextMonday, addMonths, dayLabel, dateForChoice, dueText, repeatText, hm,
    parseQuickInput, setDone, remove, htmlSetter,
  };
})();
