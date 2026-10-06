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
