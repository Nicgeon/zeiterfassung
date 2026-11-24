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

test('Pakete: Abweichung zwischen node_modules und package-lock wird erkannt (dann wird beim Start nachinstalliert)', () => {
  const { dependencyMismatches } = require('../src/lib/depsCheck');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zeit-deps-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { otplib: '^13.6.0', express: '^4.22.3' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/otplib': { version: '13.6.0' }, 'node_modules/express': { version: '4.22.3' } } }));
  const install = (name, version) => {
    fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ version }));
  };
  install('express', '4.22.3');
  install('otplib', '12.0.1'); // Update hat die Paketliste geändert, nachinstalliert wurde nicht
  assert.deepEqual(dependencyMismatches(root), [{ name: 'otplib', installed: '12.0.1', expected: '13.6.0' }]);
  install('otplib', '13.6.0');
  assert.deepEqual(dependencyMismatches(root), []);
  fs.rmSync(path.join(root, 'node_modules', 'express'), { recursive: true });
  assert.deepEqual(dependencyMismatches(root), [{ name: 'express', installed: null, expected: '4.22.3' }]);
});

test('Pakete: .npmrc schaltet Installationsskripte ab (nichts kompilieren), Update darf sie verteilen', () => {
  const npmrc = fs.readFileSync(path.join(__dirname, '..', '.npmrc'), 'utf8');
  assert.match(npmrc, /^ignore-scripts=true$/m);
  assert.ok(isUpdatablePath('.npmrc'));
  for (const f of ['Zeiterfassung-starten.bat', 'Zeiterfassung-starten.sh', 'src/launcher.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/npm rebuild/.test(src), `${f}: kein npm rebuild mehr`);
    for (const m of src.matchAll(/npm install --[^\n]*|\['install'[^\]]*\]/g)) assert.match(m[0], /ignore-scripts/, `${f}: ${m[0]}`);
  }
});
