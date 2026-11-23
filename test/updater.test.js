'use strict';

// Updater: welche Dateien er anfassen darf und wie umbenannte Startdateien aufgeräumt werden.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-upd-'));
process.env.LOCAL_MODE = 'true';
const { isUpdatablePath, retireRenamed } = require('../src/lib/updater');

test('Updater: neue Startdateien sind erlaubt, fremde Dateien und Pfade nicht', () => {
  for (const ok of ['Zeiterfassung-starten.bat', 'Zeiterfassung-starten.sh', 'Zeiterfassung-starten.command', 'start-app.bat', 'src/server.js']) {
    assert.ok(isUpdatablePath(ok), ok);
  }
  for (const bad of ['evil.bat', '../x.js', '.env', 'data/app.db', 'Zeiterfassung starten.bat']) {
    assert.ok(!isUpdatablePath(bad), bad);
  }
});

test('Updater: alte Startdatei wird erst entfernt, wenn die neue da ist (mit Sicherung)', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-app-'));
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-bak-'));
  fs.writeFileSync(path.join(app, 'start-local.bat'), 'alt');
  fs.writeFileSync(path.join(app, 'start-local.sh'), 'alt');
  assert.deepEqual(retireRenamed('s1', app, backup), [], 'neue Dateien fehlen noch: nichts entfernen');
  fs.writeFileSync(path.join(app, 'Zeiterfassung-starten.bat'), 'neu');
  assert.deepEqual(retireRenamed('s2', app, backup), ['start-local.bat']);
  assert.ok(!fs.existsSync(path.join(app, 'start-local.bat')));
  assert.ok(fs.existsSync(path.join(app, 'start-local.sh')), 'ohne neue .sh bleibt die alte');
  assert.equal(fs.readFileSync(path.join(backup, 's2', 'start-local.bat'), 'utf8'), 'alt');
});
