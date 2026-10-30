'use strict';

// Berichtsheft-Text mit KI: Einstellungen (Konto) und Erzeugen (Wochenbericht).
// Der Server baut die Vorschau immer neu aus den gespeicherten Eintraegen auf; gesendet wird nur,
// was die Vorschau zeigt (Pruefsumme "hash").

(function () {
  const $ = (sel) => document.querySelector(sel);
  const KIND_LABEL = { person: 'Person', kunde: 'Kunde', firma: 'Firma' };

  // ===================================================================================
  // Einstellungen (account.html)
  // ===================================================================================
  function initSettings() {
    const els = {
      error: $('#bhSettingsError'),
      badge: $('#bhKeyBadge'),
      provider: $('#bhProvider'),
      model: $('#bhModel'),
      modelList: $('#bhModelList'),
      apiKey: $('#bhApiKey'),
      keyHint: $('#bhKeyHint'),
      baseUrlField: $('#bhBaseUrlField'),
      baseUrl: $('#bhBaseUrl'),
      test: $('#bhTestBtn'),
      clear: $('#bhClearKeyBtn'),
      persons: $('#bhPersons'),
      customers: $('#bhCustomers'),
      firms: $('#bhFirms'),
      allow: $('#bhAllow'),
      keywords: $('#bhKeywords'),
      save: $('#bhSaveBtn'),
    };
    let settings = null;

    const split = (value) => value.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean);
    const join = (list) => list.join(', ');
    const current = () => settings.providers.find((p) => p.id === els.provider.value);

    function showProvider() {
      const p = current();
      if (!p) return;
      els.model.value = p.model || '';
      els.model.placeholder = p.defaultModel ? `Standard: ${p.defaultModel}` : 'Modellname';
      els.apiKey.value = '';
      els.baseUrlField.classList.toggle('hidden', p.id !== 'kompatibel');
      els.baseUrl.value = p.baseUrl || '';
      els.clear.classList.toggle('hidden', !p.hasKey);
      if (p.hasKey) els.keyHint.textContent = 'Ein Schlüssel ist gespeichert (verschlüsselt). Zum Ersetzen einfach einen neuen einfügen.';
      else if (p.hasEnvKey) els.keyHint.textContent = 'Es wird der Schlüssel aus der Server-Umgebung verwendet. Ein eigener hier hat Vorrang.';
      else if (p.id === 'kompatibel') els.keyHint.textContent = 'Ein Schlüssel ist nur nötig, wenn die Adresse einen verlangt.';
      else els.keyHint.textContent = 'Noch kein Schlüssel hinterlegt. Den bekommst du in der Entwicklerkonsole des Anbieters.';
      const ready = p.hasKey || p.hasEnvKey || p.id === 'kompatibel';
      els.badge.textContent = !settings.aiAllowed ? 'abgeschaltet' : ready ? 'bereit' : 'nicht eingerichtet';
      els.badge.classList.toggle('badge--success', settings.aiAllowed && ready);
      els.modelList.innerHTML = (p.suggestedModels || []).map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
    }

    function render(data) {
      settings = data;
      els.provider.innerHTML = data.providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');
      els.provider.value = data.provider;
      const of = (kind) => join(data.names.filter((n) => n.kind === kind).map((n) => n.term));
      els.persons.value = of('person');
      els.customers.value = of('kunde');
      els.firms.value = of('firma');
      els.allow.value = join(data.allow);
      els.keywords.value = join(data.keywords);
      showProvider();
      if (!data.aiAllowed) setFormError(els.error, 'Externe KI-Anbieter sind auf diesem Server abgeschaltet.');
    }

    function payload(extra) {
      const names = [
        ...split(els.persons.value).map((term) => ({ term, kind: 'person' })),
        ...split(els.customers.value).map((term) => ({ term, kind: 'kunde' })),
        ...split(els.firms.value).map((term) => ({ term, kind: 'firma' })),
      ];
      return {
        provider: els.provider.value,
        model: els.model.value.trim(),
        apiKey: els.apiKey.value.trim() || undefined,
        baseUrl: current() && current().id === 'kompatibel' ? els.baseUrl.value.trim() : undefined,
        names,
        allow: split(els.allow.value),
        keywords: split(els.keywords.value),
        ...extra,
      };
    }

    async function save(extra, message) {
      setFormError(els.error, '');
      try {
        render(await Api.put('/api/berichtsheft/settings', payload(extra)));
        showToast(message);
      } catch (err) {
        setFormError(els.error, err.message);
      }
    }

    els.provider.addEventListener('change', showProvider);
    els.save.addEventListener('click', () => save({}, 'Gespeichert.'));
    els.clear.addEventListener('click', () => save({ clearKey: true, apiKey: undefined }, 'Schlüssel entfernt.'));
    els.test.addEventListener('click', async () => {
      setFormError(els.error, '');
      els.test.disabled = true;
      try {
        // erst speichern (Schluessel, Modell), dann gegen den Anbieter pruefen
        render(await Api.put('/api/berichtsheft/settings', payload({})));
        const r = await Api.post('/api/berichtsheft/models', {});
        els.modelList.innerHTML = r.models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
        showToast(r.currentFound
          ? `Verbindung funktioniert (${r.models.length} Modelle).`
          : `Verbindung funktioniert, aber das Modell „${r.current}“ gibt es dort nicht – bitte aus der Liste im Feld „Modell“ wählen.`,
        r.currentFound ? undefined : { durationMs: 8000 });
      } catch (err) {
        setFormError(els.error, err.message);
      } finally {
        els.test.disabled = false;
      }
    });

    Api.get('/api/berichtsheft/settings').then(render).catch((err) => setFormError(els.error, err.message));
  }

  // ===================================================================================
  // Erzeugen (wochenbericht.html)
  // ===================================================================================
  function initGenerator() {
    const els = {
      error: $('#bhError'),
      badge: $('#bhAiBadge'),
      prepare: $('#bhPrepareBtn'),
      review: $('#bhReview'),
      reviewList: $('#bhReviewList'),
      reviewBtn: $('#bhReviewBtn'),
      preview: $('#bhPreview'),
      items: $('#bhItems'),
      replaced: $('#bhReplaced'),
      addTerm: $('#bhAddTerm'),
      addKind: $('#bhAddKind'),
      addBtn: $('#bhAddBtn'),
      send: $('#bhSendBtn'),
      local: $('#bhLocalBtn'),
      sendHint: $('#bhSendHint'),
      result: $('#bhResult'),
      warnings: $('#bhWarnings'),
      work: $('#bhWork'),
      school: $('#bhSchool'),
      lines: $('#bhLines'),
      copyAll: $('#bhCopyAllBtn'),
      download: $('#bhDownloadBtn'),
      again: $('#bhAgainBtn'),
      assign: $('#bhAssignList'),
    };
    let week = null; // { from, to } - kommt von weekly.js
    let prep = null; // letzte Vorschau
    let lastLabel = '';

    document.addEventListener('weekchange', (e) => {
      week = e.detail;
      hideAll();
    });

    function hideAll() {
      prep = null;
      for (const el of [els.review, els.preview, els.result]) el.classList.add('hidden');
      setFormError(els.error, '');
    }

    function renderBadge(ai) {
      els.badge.textContent = !ai.allowed ? 'KI abgeschaltet' : ai.usable ? `${ai.label.split(' (')[0]} · ${ai.model}` : 'kein Schlüssel';
      els.badge.classList.toggle('badge--success', ai.usable);
    }

    function renderPending() {
      if (!prep.pending.length) { els.review.classList.add('hidden'); return; }
      els.review.classList.remove('hidden');
      els.reviewList.innerHTML = prep.pending.map((p, i) => `
        <div class="bh-word${p.strong ? ' bh-word--strong' : ''}">
          <div class="bh-word__name">${escapeHtml(p.word)}<small>${escapeHtml(p.reason)}</small></div>
          <select data-index="${i}" aria-label="Art von ${escapeHtml(p.word)}">
            ${p.strong ? '<option value="">Bitte wählen …</option>' : ''}
            <option value="harmlos"${p.strong ? '' : ' selected'}>kein Name (normales Wort)</option>
            <option value="begriff">Begriff, nie ersetzen</option>
            <option value="person">Person</option>
            <option value="kunde">Kunde</option>
            <option value="firma">Firma</option>
          </select>
        </div>`).join('');
    }

    function renderPreview() {
      const noPending = prep.pending.length === 0;
      els.preview.classList.toggle('hidden', !noPending);
      els.items.innerHTML = prep.items.map((i) => `
        <li>${escapeHtml(i.text)}${i.count > 1 ? ` <span class="badge">${i.count}×</span>` : ''}${i.school ? ' <span class="badge badge--school">Berufsschule</span>' : ''}</li>`).join('');
      els.replaced.textContent = prep.replaced.length
        ? `Ersetzt (nur hier sichtbar): ${prep.replaced.map((r) => `${r.from} → ${KIND_LABEL[r.kind]}${r.count > 1 ? ` ×${r.count}` : ''}`).join('; ')}`
        : 'Es wurde kein Name ersetzt.';
      els.send.disabled = !prep.ai.usable;
      els.send.textContent = prep.ai.usable ? `An ${prep.ai.label.split(' (')[0]} senden` : 'An KI senden';
      els.sendHint.textContent = !prep.ai.allowed
        ? 'Externe KI-Anbieter sind auf diesem Server abgeschaltet.'
        : prep.ai.usable
          ? `Es wird genau dieser Text an ${prep.ai.label} (Modell ${prep.ai.model}${prep.ai.endpoint ? `, Server ${prep.ai.endpoint}` : ''}) gesendet.`
          : 'Für das Senden fehlt noch ein API-Schlüssel – siehe „KI-Einstellungen“.';
      renderBadge(prep.ai);
    }

    function show(data) {
      prep = data;
      els.result.classList.add('hidden');
      if (!data.items.length) {
        els.review.classList.add('hidden');
        els.preview.classList.add('hidden');
        setFormError(els.error, 'In diesem Zeitraum gibt es keine Einträge mit Text.');
        renderBadge(data.ai);
        return;
      }
      setFormError(els.error, '');
      renderPending();
      renderPreview();
    }

    async function run(button, fn) {
      button.disabled = true;
      setFormError(els.error, '');
      try { await fn(); } catch (err) { setFormError(els.error, err.message); } finally { button.disabled = false; }
    }

    els.prepare.addEventListener('click', () => run(els.prepare, async () => {
      if (!week) return;
      show(await Api.post('/api/berichtsheft/prepare', week));
    }));

    els.reviewBtn.addEventListener('click', () => run(els.reviewBtn, async () => {
      const decisions = [];
      for (const select of els.reviewList.querySelectorAll('select')) {
        if (!select.value) throw new Error('Bitte für alle rot markierten Wörter eine Auswahl treffen.');
        decisions.push({ word: prep.pending[Number(select.dataset.index)].word, kind: select.value });
      }
      show(await Api.post('/api/berichtsheft/review', { ...week, decisions }));
    }));

    els.addBtn.addEventListener('click', () => run(els.addBtn, async () => {
      const term = els.addTerm.value.trim();
      if (!term) return;
      show(await Api.post('/api/berichtsheft/review', { ...week, names: [{ term, kind: els.addKind.value }] }));
      els.addTerm.value = '';
    }));

    function showResult(r) {
      lastLabel = r.label;
      els.result.classList.remove('hidden');
      els.work.value = r.betrieb;
      els.school.value = r.schule;
      els.warnings.innerHTML = r.warnings.map((w) => `<div class="alert alert--error">${escapeHtml(w)}</div>`).join('');
      els.lines.textContent = `Umfang: ca. ${r.lines.total} Zeilen (Betrieb ${r.lines.work}, Schule ${r.lines.school}). Du kannst die Texte hier noch von Hand ändern.`;
      els.assign.innerHTML = r.assignment.map((a) => `<li><strong>${a.block === 'schule' ? 'Berufsschule' : 'Betrieb'}:</strong> ${escapeHtml(a.text)}</li>`).join('');
      els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function generate(button, mode) {
      // Langsame Modelle brauchen Minuten: Wartezeit sichtbar machen
      const original = button.textContent;
      const started = Date.now();
      const tick = () => {
        const s = Math.floor((Date.now() - started) / 1000);
        button.textContent = `Warte auf die KI … ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      };
      let timer = null;
      if (mode === 'ki') {
        tick();
        timer = setInterval(tick, 1000);
        els.sendHint.textContent = 'Das Modell schreibt gerade. Bei Noah AI kann das mehrere Minuten dauern – bitte die Seite offen lassen.';
      }
      try {
        await run(button, async () => {
          showResult(await Api.post('/api/berichtsheft/generate', { ...week, hash: prep.hash, mode }));
        });
      } finally {
        if (timer) clearInterval(timer);
        button.textContent = original;
        if (prep) renderPreview();
      }
    }
    els.send.addEventListener('click', () => generate(els.send, 'ki'));
    els.again.addEventListener('click', () => generate(els.again, 'ki'));
    els.local.addEventListener('click', () => generate(els.local, 'lokal'));

    function fullText() {
      return `Betriebliche Tätigkeiten:\n${els.work.value.trim()}\n\nBerufsschule (Unterrichtsthemen):\n${els.school.value.trim()}\n`;
    }
    for (const btn of document.querySelectorAll('[data-copy]')) {
      btn.addEventListener('click', async () => {
        const ok = await copyToClipboard($(`#${btn.dataset.copy}`).value.trim());
        showToast(ok ? 'Kopiert.' : 'Kopieren fehlgeschlagen.');
      });
    }
    els.copyAll.addEventListener('click', async () => {
      showToast((await copyToClipboard(fullText())) ? 'Beide Blöcke kopiert.' : 'Kopieren fehlgeschlagen.');
    });
    els.download.addEventListener('click', () => downloadFile(`berichtsheft_${lastLabel}.txt`, fullText(), 'text/plain;charset=utf-8'));
  }

  if ($('#bhSettingsCard')) initSettings();
  if ($('#bhCard')) initGenerator();
})();
