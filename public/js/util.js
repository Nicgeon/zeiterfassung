'use strict';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function nowHHMM() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isTodayISO(dateStr) {
  return dateStr === todayISO();
}

/** 105 -> "1 Std 45 Min" */
function formatDurationLong(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} Min`;
  if (m === 0) return `${h} Std`;
  return `${h} Std ${m} Min`;
}

/** 105 -> "1h 45m" (Jira-style short duration) */
function formatDurationJira(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** 285 -> "4:45" (Stunden:Minuten, fuer Summen und Balken) */
function formatHM(minutes) {
  return `${Math.floor(minutes / 60)}:${pad2(minutes % 60)}`;
}

/** "2026-10-06" -> { weekday: "Dienstag", date: "6. Oktober 2026" } */
function formatDateParts(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return {
    weekday: date.toLocaleDateString('de-DE', { weekday: 'long' }),
    date: date.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }),
  };
}

function formatDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// --- Sortierung von Eintraegen (Tagesliste und Uebersicht) ----------------
// Die Auswahl wird pro Browser gemerkt (kein Server-Zustand noetig).

const SORT_KEY = 'zeit.sortMode';
const SORT_MODES = ['time-asc', 'time-desc', 'duration-desc', 'ticket'];

function loadSortMode() {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (SORT_MODES.includes(saved)) return saved;
  } catch { /* localStorage nicht verfuegbar - Standard verwenden */ }
  return 'time-asc';
}

function saveSortMode(mode) {
  try { localStorage.setItem(SORT_KEY, mode); } catch { /* nur Komfort */ }
}

/** Neue, sortierte Liste; die uebergebene bleibt unveraendert. */
function sortEntries(entries, mode) {
  const chrono = (a, b) =>
    (a.workDate || '').localeCompare(b.workDate || '') ||
    a.startTime.localeCompare(b.startTime) ||
    a.id - b.id;
  const list = [...entries];
  switch (mode) {
    case 'time-desc':
      return list.sort((a, b) => chrono(b, a));
    case 'duration-desc':
      return list.sort((a, b) => b.durationMinutes - a.durationMinutes || chrono(a, b));
    case 'ticket':
      // Eintraege ohne Ticket ans Ende, sonst alphabetisch, innerhalb eines Tickets chronologisch.
      return list.sort((a, b) => {
        if (!a.jiraKey !== !b.jiraKey) return a.jiraKey ? -1 : 1;
        return (a.jiraKey || '').localeCompare(b.jiraKey || '', 'de') || chrono(a, b);
      });
    default:
      return list.sort(chrono);
  }
}

// --- Kopierformat -----------------------------------------------------------
// Standard: ohne Uhrzeiten ("60 Min – Text [TICKET]"). Wer die Uhrzeiten mit
// kopieren moechte, schaltet das unter Konto -> Einstellungen ein (pro Browser).

const COPY_TIMES_KEY = 'zeit.copyTimes';

function loadCopyTimes() {
  try {
    return localStorage.getItem(COPY_TIMES_KEY) === '1';
  } catch {
    return false;
  }
}

function saveCopyTimes(enabled) {
  try { localStorage.setItem(COPY_TIMES_KEY, enabled ? '1' : '0'); } catch { /* nur Komfort */ }
}

/** Eine Zeile fuer die Zwischenablage; withTimes haengt Start-/Endzeit davor. */
function entryLine(entry, withTimes) {
  const text = `${entry.description}${entry.jiraKey ? ` [${entry.jiraKey}]` : ''}`;
  return withTimes
    ? `${entry.startTime}–${entry.endTime} (${entry.durationMinutes} Min) – ${text}`
    : `${entry.durationMinutes} Min – ${text}`;
}

// --- Symbole (Linien-Icons, erben die Textfarbe) ---------------------------

const ICONS = {
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};

// --- Dateien speichern ------------------------------------------------------

function downloadFile(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Semikolon-getrennt mit BOM, damit Excel (de-DE) Umlaute und Spalten richtig liest. */
function toCsv(rows) {
  const cell = (value) => {
    let text = value === null || value === undefined ? '' : String(value);
    // Schutz vor Formel-Einschleusung in Tabellenkalkulationen
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[";\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return '\ufeff' + rows.map((row) => row.map(cell).join(';')).join('\r\n') + '\r\n';
}

let toastTimer = null;

/**
 * Kurze Rueckmeldung am unteren Rand.
 * Optional mit Aktionsknopf, z.B. "Rueckgaengig" nach dem Loeschen:
 *   showToast('Geloescht.', { label: 'Rueckgaengig', onClick: fn, durationMs: 30000 })
 */
function showToast(message, action) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = '';

  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);

  let countdownTimer = null;
  const hide = () => {
    el.classList.remove('show');
    clearInterval(countdownTimer);
  };

  if (action && action.label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    const totalSeconds = Math.round((action.durationMs || 30000) / 1000);
    let remaining = totalSeconds;
    const setLabel = () => { btn.textContent = `${action.label} (${remaining}s)`; };
    setLabel();
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) hide();
      else setLabel();
    }, 1000);
    btn.addEventListener('click', () => {
      hide();
      action.onClick();
    });
    el.appendChild(btn);
  }

  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, (action && action.durationMs) || 2400);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback fuer Browser/Kontexte ohne Clipboard-API (z.B. kein HTTPS)
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.className = 'clipboard-fallback-textarea';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

function setFormError(container, message) {
  container.innerHTML = message
    ? `<div class="alert alert--error">${escapeHtml(message)}</div>`
    : '';
}
