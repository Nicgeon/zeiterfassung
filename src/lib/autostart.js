'use strict';

// Beim Anmelden automatisch im Hintergrund starten (ohne Fenster), damit Erinnerungen auch kommen, wenn das
// Programmfenster zu ist. Windows: Skript im Autostart-Ordner, macOS: LaunchAgent, Linux: .desktop-Eintrag.
// Alles liegt im Benutzerordner, es sind keine Administratorrechte nötig.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ARG = '--hintergrund';

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Dateiname des Autostart-Eintrags oder null, wenn die Plattform nicht unterstützt wird. */
function autostartFile({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Zeiterfassung.vbs');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', 'de.zeiterfassung.hintergrund.plist');
  if (platform === 'linux') return path.join(home, '.config', 'autostart', 'zeiterfassung.desktop');
  return null;
}

/** Inhalt des Eintrags; root = Programmordner. */
function autostartContent(platform, root) {
  if (platform === 'win32') {
    // Gleiches Muster wie Zeiterfassung-Mini.vbs: cmd /c "<Ordner>\start-app.bat" --hintergrund. Genau ein Paar
    // Anführungszeichen um den Pfad – bei zwei Paaren entfernt cmd sie, und der Pfad zerfällt an Leerzeichen.
    // Der Ordner wird immer mit "\" angehängt (path.join würde unter Linux/Tests "/" benutzen).
    const dir = root.replace(/[\\/]+$/, '').replace(/"/g, '""');
    return [
      "' Startet die Zeiterfassung beim Anmelden im Hintergrund (ohne Fenster).",
      'Option Explicit',
      'Dim sh, dir',
      `dir = "${dir}"`,
      'Set sh = CreateObject("WScript.Shell")',
      'sh.CurrentDirectory = dir',
      `sh.Run "cmd /c """ & dir & "\\start-app.bat"" ${ARG}", 0, False`,
      '',
    ].join('\r\n');
  }
  if (platform === 'darwin') {
    const script = path.join(root, 'start-app.sh');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>de.zeiterfassung.hintergrund</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xmlEscape(script)}</string>
    <string>${ARG}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
  }
  const script = path.join(root, 'start-app.sh').replace(/(["\\`$])/g, '\\$1');
  return `[Desktop Entry]
Type=Application
Name=Zeiterfassung (Hintergrund)
Exec=/bin/bash "${script}" ${ARG}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function createAutostart({ root, platform = process.platform, home = os.homedir(), env = process.env, fsImpl = fs } = {}) {
  const file = autostartFile({ platform, home, env });
  return {
    supported: !!file,
    file,
    isEnabled: () => !!file && fsImpl.existsSync(file),
    enable() {
      if (!file) throw new Error('Autostart wird auf diesem System nicht unterstützt.');
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      const content = autostartContent(platform, root);
      // Windows Script Host liest UTF-16 mit BOM sicher (Umlaute im Pfad, z. B. C:\Users\Jörg); sonst UTF-8
      if (platform === 'win32') fsImpl.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
      else fsImpl.writeFileSync(file, content);
    },
    disable() {
      if (file) fsImpl.rmSync(file, { force: true });
    },
  };
}

module.exports = { ARG, autostartFile, autostartContent, createAutostart };
