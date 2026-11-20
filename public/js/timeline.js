'use strict';

// Zeitstrahl des Tages: echte Arbeitszeiträume der Einträge (unterbrochene Aufgaben als mehrere Blöcke), der laufende
// Timer, Lücken zum Nachtragen und Einträge ohne bekannte Uhrzeit. Der Bereich passt sich an: volle Stunde vor dem
// ersten Block bis eine Stunde nach dem letzten bzw. jetzt.
(function () {
  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const toHM = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const MIN_GAP = 10; // kleinere Lücken werden nicht angeboten

  /**
   * @param {HTMLElement} host
   * @param {{entries: object[], timer: object|null, showTimes: boolean, isToday: boolean, now: string, onGap: Function, slim?: boolean}} o
   *   slim: schmale Fassung (Mini-Fenster): ohne Beschriftung in den Blöcken, Achse nur mit Stunden, ohne Liste "ohne Uhrzeit"
   */
  function render(host, o) {
    if (!host) return;
    const blocks = [];
    const free = [];
    for (const e of o.entries) {
      const parts = e.segments || (o.showTimes ? [[e.startTime, e.endTime]] : null);
      if (!parts) { free.push(e); continue; }
      parts.forEach((p, i) => blocks.push({ s: toMin(p[0]), e: toMin(p[1]), entry: e, part: parts.length > 1 ? i + 1 : 0, parts: parts.length }));
    }
    const nowMin = toMin(o.now);
    if (o.timer && o.isToday) {
      for (const p of o.timer.carrySegments || []) blocks.push({ s: toMin(p[0]), e: toMin(p[1]), running: true, carry: true });
      // der laufende Block endet genau an der Jetzt-Linie und wächst mit ihr nach rechts
      blocks.push({ s: toMin(o.timer.startTime), e: Math.max(nowMin, toMin(o.timer.startTime)), running: true });
    }
    blocks.sort((a, b) => a.s - b.s);

    if (!blocks.length && !free.length) {
      const empty = '<div class="tl-empty">Noch nichts erfasst. Starte den Timer oder trage etwas nach – hier erscheint dann dein Tag.</div>';
      if (host._html !== empty) { host.innerHTML = empty; host._html = empty; }
      return;
    }
    const first = blocks.length ? blocks[0].s : (o.isToday ? nowMin : 8 * 60);
    const last = Math.max(blocks.length ? Math.max(...blocks.map((b) => b.e)) : first, o.isToday ? nowMin : 0);
    const S = Math.max(0, Math.floor(first / 60) * 60);
    const E = Math.min(24 * 60, Math.ceil(last / 60) * 60 + 60);
    const span = E - S;
    const pos = (m) => (((m - S) / span) * 100).toFixed(3); // Prozent; gesetzt per CSSOM (die CSP verbietet style-Attribute)
    const width = (a, b) => ((b - a) / span) * 100;

    // Lücken zwischen den Blöcken (und vom letzten Block bis jetzt), nur heute bis jetzt bzw. an anderen Tagen dazwischen
    const gaps = [];
    let cursor = null;
    for (const b of blocks) {
      if (cursor !== null && b.s - cursor >= MIN_GAP) gaps.push([cursor, b.s]);
      cursor = cursor === null ? b.e : Math.max(cursor, b.e);
    }
    if (o.isToday && !o.timer && cursor !== null && nowMin - cursor >= MIN_GAP) gaps.push([cursor, nowMin]);

    const blockHtml = blocks.map((b) => {
      const w = width(b.s, b.e);
      const e = b.entry;
      const cls = b.running ? 'tl-block--running' : e && e.transferred ? 'tl-block--done' : 'tl-block--open';
      const label = b.running ? (b.carry ? '' : 'läuft') : (e.jiraKey || e.description || '');
      const title = b.running
        ? `Läuft seit ${toHM(b.s)}`
        : `${e.description || e.jiraKey || ''} · ${toHM(b.s)}–${toHM(b.e)}${b.part ? ` · Teil ${b.part} von ${b.parts}` : ''}${e.transferred ? ' · in Jira' : ''}`;
      // schmale Blöcke ohne Beschriftung und ohne Innenabstand, damit sie nicht breiter als ihre Zeit werden
      // (ein gerade gestarteter Timer endet so genau an der Jetzt-Linie)
      const labelled = w > 8 && !o.slim;
      return `<div class="tl-block ${cls}${labelled ? '' : ' tl-block--narrow'}" data-l="${pos(b.s)}" data-w="${w.toFixed(3)}" data-pad="${b.running && !b.carry ? 0 : 3}" title="${escapeHtml(title)}"${e ? ` data-entry="${e.id}"` : ''}>${labelled ? `<span>${escapeHtml(label)}</span>` : ''}</div>`;
    }).join('');
    const gapHtml = gaps.map(([a, b]) => {
      const w = width(a, b);
      return `<button type="button" class="tl-gap" data-l="${pos(a)}" data-w="${w.toFixed(3)}" data-off="2" data-pad="6" data-gap="${toHM(a)}-${toHM(b)}" title="${toHM(a)}–${toHM(b)} nachtragen" aria-label="Lücke ${toHM(a)} bis ${toHM(b)} nachtragen">${w > 7 && !o.slim ? '+ Nachtragen' : '+'}</button>`;
    }).join('');
    const nowHtml = o.isToday && nowMin >= S && nowMin <= E ? `<div class="tl-now" data-l="${pos(nowMin)}" aria-hidden="true"></div>` : '';
    const step = o.slim ? (span > 9 * 60 ? 3 : span > 5 * 60 ? 2 : 1) : span > 12 * 60 ? 2 : 1;
    const hours = [];
    for (let h = S / 60; h <= E / 60; h += step) hours.push(`<span data-l="${pos(h * 60)}">${String(h).padStart(2, '0')}${o.slim ? '' : ':00'}</span>`);
    const freeHtml = free.length && !o.slim
      ? `<div class="tl-free"><span>Ohne Uhrzeit erfasst:</span>${free.map((e) => `<span class="tl-chip">${escapeHtml(e.description || e.jiraKey || '')} <strong class="mono">${formatDurationLong(e.durationMinutes)}</strong></span>`).join('')}</div>`
      : '';

    const html = `
      <div class="tl-track" role="img" aria-label="Zeitstrahl von ${toHM(S)} bis ${toHM(E)}">${blockHtml}${gapHtml}${nowHtml}</div>
      <div class="tl-axis" aria-hidden="true">${hours.join('')}</div>
      ${freeHtml}`;
    // nur bei Änderungen neu zeichnen (sonst ginge ein Klick während des Minuten-Takts verloren)
    if (host._html !== html) {
      host.innerHTML = html;
      host._html = html;
      host.querySelectorAll('[data-l]').forEach((n) => {
        const off = Number(n.dataset.off || 0);
        n.style.left = off ? `calc(${n.dataset.l}% + ${off}px)` : `${n.dataset.l}%`;
        if (n.dataset.w) n.style.width = `calc(${n.dataset.w}% - ${Number(n.dataset.pad || 0)}px)`;
      });
    }
    host.onclick = (ev) => {
      const g = ev.target.closest('[data-gap]');
      if (g && o.onGap) { const [a, b] = g.dataset.gap.split('-'); o.onGap(a, b); }
    };
  }

  window.ZeitTimeline = { render };
})();
