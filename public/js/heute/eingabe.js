'use strict';

// Eingabehilfen im Erfassungsformular: Vorschläge aus früheren Einträgen, Jira-Links werden zu Ticketnummern,
// Tastenkürzel (Strg+Enter speichert, Enter in "Jetzt starten" startet den Timer).
// Teil der Seite "Heute" (index.html); gemeinsamer Zustand in heute/kern.js, Start in heute/start.js.
(function () {
  const H = window.Heute;
  const { state, els } = H;
  // aus anderen Teilen (erst beim Aufruf nachgeschlagen, weil die Dateien nacheinander laden)
  const { composeView, saveTimerFields } = H.later;

  // --- Vorschläge ---------------------------------------------------
  /** Vorschlagsliste unter einem Textfeld (früher erfasste Texte, häufige zuerst); onApply bekommt den Vorschlag. */
  function attachSuggest(input, list, onApply) {
    let timer = null;
    let suggestions = [];

    const hide = () => list.classList.add('hidden');

    function render() {
      if (suggestions.length === 0) return hide();
      list.innerHTML = suggestions
        .map(
          (s, i) => `<li class="suggest-item" data-index="${i}">
              <span>${escapeHtml(s.description)}</span>
              ${s.jiraKey ? `<span class="jira-tag">${escapeHtml(s.jiraKey)}</span>` : ''}
            </li>`
        )
        .join('');
      list.classList.remove('hidden');
    }

    async function fetchSuggestions() {
      const query = input.value.trim();
      // Mehrzeilige Texte sind meist fertig getippt - dann nicht vorschlagen.
      if (query.includes('\n')) return hide();
      try {
        const data = await Api.get(`/api/entries/suggestions?q=${encodeURIComponent(query)}`);
        suggestions = data.suggestions.filter((s) => s.description !== query);
        // Antwort kam erst nach dem Verlassen des Feldes: Liste nicht mehr einblenden
        if (document.activeElement !== input) return hide();
        render();
      } catch {
        hide();
      }
    }

    const schedule = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(fetchSuggestions, ms);
    };

    input.addEventListener('input', () => schedule(180));
    input.addEventListener('focus', () => schedule(120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hide();
    });
    input.addEventListener('blur', () => {
      clearTimeout(timer);
      setTimeout(hide, 120);
    });
    list.addEventListener('mousedown', (e) => {
      // mousedown statt click: sonst schliesst das blur-Ereignis die Liste zuerst
      const item = e.target.closest('.suggest-item');
      if (!item) return;
      e.preventDefault();
      const suggestion = suggestions[Number(item.dataset.index)];
      if (!suggestion) return;
      input.value = suggestion.description;
      hide();
      input.focus();
      onApply(suggestion);
    });
  }

  attachSuggest(els.description, els.suggestList, (s) => {
    if (s.jiraKey && !els.jiraKey.value.trim()) els.jiraKey.value = s.jiraKey;
    saveTimerFields(); // wirkt nur, solange ein Timer laeuft
  });

  // --- Jira-Links -> Ticketnummern ----------------------------------
  /** Ticketfeld: ein eingefuegter Jira-Link wird sofort zur Ticketnummer. */
  function convertLinksInTicketField(input, onChange) {
    input.addEventListener('input', () => {
      const converted = convertTicketLinks(input.value);
      if (converted === input.value) return;
      input.value = converted.trim();
      if (onChange) onChange();
    });
  }

  /**
   * Textfeld: Jira-Links im eingefuegten Text werden zu Ticketnummern. Ist das
   * Ticketfeld noch leer, wird die erste gefundene Nummer dort eingetragen.
   */
  function convertLinksOnPaste(input, onTicketKey) {
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData && e.clipboardData.getData('text');
      if (!text) return;
      const converted = convertTicketLinks(text);
      if (converted === text) return;
      e.preventDefault();
      // insertText erhaelt den Rueckgaengig-Verlauf des Browsers
      if (!document.execCommand('insertText', false, converted)) {
        input.setRangeText(converted, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const key = firstLinkedKey(text);
      if (key) onTicketKey(key);
    });
  }

  convertLinksInTicketField(els.jiraKey, saveTimerFields);
  convertLinksOnPaste(els.description, (key) => {
    if (!els.jiraKey.value.trim()) els.jiraKey.value = key;
    saveTimerFields();
  });

  // Strg+Enter (bzw. Cmd+Enter) speichert aus dem Textfeld; Enter im Timerfeld startet den Timer.
  els.description.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      els.form.requestSubmit();
    } else if (e.key === 'Enter' && !e.shiftKey && composeView() === 'start' && !state.timer && !state.editingId) {
      // "Jetzt starten": eine Zeile wie ein Suchfeld, Enter startet den Timer
      e.preventDefault();
      els.suggestList.classList.add('hidden');
      els.timerStartBtn.click();
    }
  });

  Object.assign(H, { attachSuggest, convertLinksInTicketField, convertLinksOnPaste });
})();
