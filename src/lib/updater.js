'use strict';

// Update-Pruefung und Selbstaktualisierung fuer den lokalen Betrieb.
//
// Vergleich: Fuer jede Datei der Anwendung wird der Git-Blob-Hash berechnet und
// mit dem Dateibaum des gewaehlten GitHub-Branches verglichen. So braucht es
// weder eine Versionsnummer noch ein .git-Verzeichnis. Beim Aktualisieren wird
// jede heruntergeladene Datei gegen den erwarteten Hash geprueft, bevor sie
// geschrieben wird. Vorherige Dateien landen in einer Sicherung im Datenordner.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const APP_DIR = path.join(__dirname, '..', '..');
const STATE_FILE = path.join(config.dataDir, 'update-state.json');
const BACKUP_DIR = path.join(config.dataDir, 'update-backup');
const INSTALL_MARKER = path.join(APP_DIR, '.update-install-pending');
const RESTART_EXIT_CODE = 75;
const KEEP_BACKUPS = 3;

// Nur diese Pfade werden je angefasst (keine .env, keine Daten, kein node_modules).
const ALLOWED = [
  /^src\//,
  /^public\//,
  /^package(-lock)?\.json$/,
  /^start-local\.(sh|bat)$/,
  /^README\.md$/,
  /^\.env\.example$/,
  /^\.gitattributes$/,
  /^\.gitignore$/,
  /^\.dockerignore$/,
  /^Dockerfile$/,
  /^docker-compose\.yml$/,
];
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;
const TEXT_FILE = /(\.(js|json|html|css|md|txt|sh|bat|yml|yaml|svg|example)|(^|\/)(Dockerfile|\.gitignore|\.dockerignore|\.gitattributes))$/;
const DEPENDENCY_FILES = new Set(['package.json', 'package-lock.json']);

function isUpdatablePath(p) {
  return SAFE_PATH.test(p) && !p.includes('..') && !p.startsWith('/') && ALLOWED.some((re) => re.test(p));
}

/** Git-Blob-Hash; bei Textdateien werden Windows-Zeilenenden vorher vereinheitlicht. */
function blobSha(relPath, buffer) {
  let data = buffer;
  if (TEXT_FILE.test(relPath)) data = Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return crypto
    .createHash('sha1')
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest('hex');
}

function localSha(relPath) {
  try {
    return blobSha(relPath, fs.readFileSync(path.join(APP_DIR, relPath)));
  } catch {
    return null;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch { /* Status ist nur Komfort */ }
}

// --- GitHub -------------------------------------------------------------

function validateSource() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.updateRepo)) throw new Error('UPDATE_REPO ist ungueltig (erwartet: besitzer/repository).');
  if (!/^[\w./-]+$/.test(config.updateBranch)) throw new Error('UPDATE_BRANCH ist ungueltig.');
}

function headers() {
  const h = { 'User-Agent': 'zeiterfassung-updater', Accept: 'application/vnd.github+json' };
  if (config.updateToken) h.Authorization = `Bearer ${config.updateToken}`;
  return h;
}

// Bedingte Anfragen (ETag): Aendert sich nichts, antwortet GitHub mit 304 - das zaehlt
// nicht gegen das Ratenlimit (wichtig, wenn viele Rechner hinter einer IP sitzen).
const etagCache = new Map();

async function getJson(url) {
  const h = headers();
  const cached = etagCache.get(url);
  if (cached) h['If-None-Match'] = cached.etag;
  const res = await fetch(url, { headers: h, signal: AbortSignal.timeout(15000) });
  if (res.status === 304 && cached) return cached.body;
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      'GitHub hat die Anfragen begrenzt (Ratenlimit, z. B. weil viele Rechner dieselbe Adresse nutzen). ' +
        'Bitte später erneut versuchen oder UPDATE_TOKEN setzen.'
    );
  }
  if (res.status === 404 || res.status === 422) throw new Error(`Repository oder Branch nicht gefunden (${config.updateRepo}, ${config.updateBranch}).`);
  if (!res.ok) throw new Error(`GitHub antwortete mit Status ${res.status}.`);
  const body = await res.json();
  const etag = res.headers.get('etag');
  if (etag) etagCache.set(url, { etag, body });
  return body;
}

async function fetchRemote() {
  validateSource();
  const api = `https://api.github.com/repos/${config.updateRepo}`;
  const commit = await getJson(`${api}/commits/${encodeURIComponent(config.updateBranch)}`);
  const tree = await getJson(`${api}/git/trees/${commit.commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new Error('Der Dateibaum ist zu gross fuer die Update-Pruefung.');
  return {
    commit: {
      sha: commit.sha,
      message: String(commit.commit.message || '').split('\n')[0].slice(0, 200),
      date: commit.commit.committer && commit.commit.committer.date,
    },
    files: tree.tree
      .filter((e) => e.type === 'blob' && isUpdatablePath(e.path))
      .map((e) => ({ path: e.path, sha: e.sha })),
  };
}

async function downloadFile(commitSha, file) {
  const url = `https://raw.githubusercontent.com/${config.updateRepo}/${commitSha}/${file.path}`;
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Download von ${file.path} fehlgeschlagen (Status ${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (blobSha(file.path, buffer) !== file.sha) {
    throw new Error(`Pruefsumme von ${file.path} stimmt nicht - Update abgebrochen, nichts wurde veraendert.`);
  }
  return buffer;
}

// --- Pruefen -------------------------------------------------------------

let lastCheck = null; // { at, error?, commit?, changed? }
let busy = false;

async function check() {
  if (!config.updateEnabled) throw new Error('Update-Pruefung ist deaktiviert.');
  try {
    const remote = await fetchRemote();
    const changed = remote.files
      .map((f) => {
        const current = localSha(f.path);
        return current === f.sha ? null : { path: f.path, status: current ? 'geaendert' : 'neu', sha: f.sha };
      })
      .filter(Boolean);
    if (changed.length === 0) writeState({ appliedCommit: remote.commit.sha });
    lastCheck = { at: new Date().toISOString(), commit: remote.commit, changed, files: remote.files };
    writeState({ lastCheckAt: lastCheck.at });
  } catch (err) {
    lastCheck = { at: new Date().toISOString(), error: err.name === 'TimeoutError' ? 'Zeitueberschreitung bei der Verbindung zu GitHub.' : err.message };
  }
  return status();
}

function status() {
  const state = readState();
  const base = {
    enabled: config.updateEnabled,
    repo: config.updateRepo,
    branch: config.updateBranch,
    supervised: process.env.ZEIT_SUPERVISED === '1',
    currentCommit: state.appliedCommit || null,
    busy,
  };
  if (!lastCheck) return { ...base, checked: false, available: false };
  if (lastCheck.error) return { ...base, checked: true, checkedAt: lastCheck.at, error: lastCheck.error, available: false };
  return {
    ...base,
    checked: true,
    checkedAt: lastCheck.at,
    available: lastCheck.changed.length > 0,
    latest: lastCheck.commit,
    changedCount: lastCheck.changed.length,
    changed: lastCheck.changed.slice(0, 30).map(({ path: p, status: s }) => ({ path: p, status: s })),
    needsDependencies: lastCheck.changed.some((c) => DEPENDENCY_FILES.has(c.path)),
  };
}

// --- Installieren ----------------------------------------------------------

function pruneBackups() {
  try {
    const dirs = fs.readdirSync(BACKUP_DIR).sort();
    for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP_BACKUPS))) {
      fs.rmSync(path.join(BACKUP_DIR, d), { recursive: true, force: true });
    }
  } catch { /* keine Sicherungen vorhanden */ }
}

function writeFileAtomic(target, buffer, relPath) {
  let data = buffer;
  // Windows-Stapeldateien brauchen CRLF (sonst funktionieren Sprungmarken nicht).
  if (relPath.endsWith('.bat')) data = Buffer.from(buffer.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.update-tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

/** Laedt alle geaenderten Dateien, prueft sie und ersetzt sie erst danach. */
async function apply() {
  if (!config.updateEnabled) throw new Error('Update-Pruefung ist deaktiviert.');
  if (busy) throw new Error('Es laeuft bereits ein Update.');
  busy = true;
  try {
    const remote = await fetchRemote();
    const changed = remote.files.filter((f) => localSha(f.path) !== f.sha);
    if (changed.length === 0) {
      writeState({ appliedCommit: remote.commit.sha });
      lastCheck = { at: new Date().toISOString(), commit: remote.commit, changed: [], files: remote.files };
      return { updated: 0, restart: false };
    }

    // 1. alles herunterladen und pruefen - bei einem Fehler bleibt die Installation unveraendert
    const downloaded = [];
    for (const file of changed) downloaded.push({ file, buffer: await downloadFile(remote.commit.sha, file) });

    // 2. Sicherung der bisherigen Dateien
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const { file } of downloaded) {
      const current = path.join(APP_DIR, file.path);
      if (!fs.existsSync(current)) continue;
      const backup = path.join(BACKUP_DIR, stamp, file.path);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(current, backup);
    }
    pruneBackups();

    // 3. ersetzen
    for (const { file, buffer } of downloaded) writeFileAtomic(path.join(APP_DIR, file.path), buffer, file.path);
    if (changed.some((f) => DEPENDENCY_FILES.has(f.path))) fs.writeFileSync(INSTALL_MARKER, 'npm install --omit=dev\n');
    writeState({ appliedCommit: remote.commit.sha, appliedAt: new Date().toISOString() });
    lastCheck = { at: new Date().toISOString(), commit: remote.commit, changed: [], files: remote.files };

    const supervised = process.env.ZEIT_SUPERVISED === '1';
    // Antwort noch ausliefern, dann neu starten (Startskript startet die Anwendung wieder).
    if (supervised) setTimeout(() => process.exit(RESTART_EXIT_CODE), 800).unref?.();
    return { updated: changed.length, restart: supervised, commit: remote.commit };
  } finally {
    busy = false;
  }
}

/** Beim Start und danach regelmaessig pruefen. */
function startSchedule() {
  if (!config.updateEnabled) return;
  const run = () => check().catch(() => {});
  setTimeout(run, 4000).unref();
  setInterval(run, config.updateCheckHours * 3600 * 1000).unref();
}

async function ensureChecked() {
  if (!lastCheck) await check();
  return status();
}

module.exports = { check, apply, status, ensureChecked, startSchedule, blobSha, isUpdatablePath, RESTART_EXIT_CODE };
