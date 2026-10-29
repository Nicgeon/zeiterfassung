'use strict';

// Ausgabe: fertiger Text, Datei und Zwischenablage.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { countLines } = require('./prompt');

const HEAD_WORK = 'Betriebliche Tätigkeiten:';
const HEAD_SCHOOL = 'Berufsschule (Unterrichtsthemen):';
const NO_SCHOOL = 'In diesem Zeitraum wurden keine Berufsschulthemen erfasst.';
const NO_WORK = 'In diesem Zeitraum wurden keine betrieblichen Tätigkeiten erfasst.';

function formatReport({ betrieb, schule }) {
  return `${HEAD_WORK}\n${betrieb || NO_WORK}\n\n${HEAD_SCHOOL}\n${schule || NO_SCHOOL}\n`;
}

function lineSummary({ betrieb, schule }, width = 95) {
  const a = countLines(betrieb, width);
  const b = countLines(schule, width);
  return { work: a, school: b, total: a + b };
}

function saveReportTo(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

function saveReport(dir, label, text) {
  return saveReportTo(path.join(dir, `berichtsheft_${label}.txt`), text);
}

/** Legt den Text in die Zwischenablage; liefert true bei Erfolg. */
function copyToClipboard(text) {
  const attempts = [];
  if (process.platform === 'win32') {
    // clip erwartet UTF-16 mit Byte-Order-Mark, sonst werden Umlaute zerstört
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    attempts.push(['clip', [], buf]);
  } else if (process.platform === 'darwin') {
    attempts.push(['pbcopy', [], Buffer.from(text, 'utf8')]);
  } else {
    for (const cmd of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]) {
      attempts.push([cmd[0], cmd[1], Buffer.from(text, 'utf8')]);
    }
  }
  for (const [cmd, args, input] of attempts) {
    const r = spawnSync(cmd, args, { input, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

function defaultOutputDir(dataDir) {
  return path.join(dataDir || path.join(os.homedir(), '.zeiterfassung'), 'berichtsheft');
}

module.exports = { formatReport, lineSummary, saveReport, saveReportTo, copyToClipboard, defaultOutputDir, HEAD_WORK, HEAD_SCHOOL, NO_SCHOOL };
