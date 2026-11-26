'use strict';

// Systembenachrichtigung (Windows, macOS, Linux) ohne zusätzliche Pakete. Texte gehen über
// Umgebungsvariablen an das Hilfsprogramm, nie in den Befehlstext (keine Maskierungsprobleme).

const { spawn } = require('child_process');

const WIN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$nodes = $xml.GetElementsByTagName('text')",
  '$nodes.Item(0).AppendChild($xml.CreateTextNode($env:ZEIT_TITLE)) | Out-Null',
  '$nodes.Item(1).AppendChild($xml.CreateTextNode($env:ZEIT_BODY)) | Out-Null',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  // Kennung von Windows PowerShell: ist immer registriert, daher erscheint die Meldung ohne eigene App-Registrierung
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)',
].join('; ');

/** Befehl und Argumente für die jeweilige Plattform (testbar). */
function buildCommand(platform) {
  if (platform === 'win32') return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_SCRIPT] };
  if (platform === 'darwin') {
    return { cmd: 'osascript', args: ['-e', 'display notification (system attribute "ZEIT_BODY") with title (system attribute "ZEIT_TITLE")'] };
  }
  return { cmd: 'notify-send', args: ['--app-name=Zeiterfassung', '--', '__TITLE__', '__BODY__'] };
}

/** Zeigt eine Benachrichtigung; Fehler (kein Hilfsprogramm o. ä.) werden nur gemeldet, nie geworfen. */
function notify({ title, body }, { platform = process.platform, spawnImpl = spawn, log = () => {} } = {}) {
  const t = String(title || 'Zeiterfassung').slice(0, 120);
  const b = String(body || '').slice(0, 400);
  const { cmd, args } = buildCommand(platform);
  const finalArgs = args.map((a) => (a === '__TITLE__' ? t : a === '__BODY__' ? b : a));
  try {
    const child = spawnImpl(cmd, finalArgs, {
      stdio: 'ignore',
      windowsHide: true,
      detached: true, // überlebt den Starter, der sich beim zweiten Start gleich wieder beendet (Windows: Job-Objekt)
      env: { ...process.env, ZEIT_TITLE: t, ZEIT_BODY: b },
    });
    child.on('error', (err) => log(`Benachrichtigung nicht möglich (${cmd}): ${err.message}`));
    child.unref && child.unref();
    return true;
  } catch (err) {
    log(`Benachrichtigung nicht möglich (${cmd}): ${err.message}`);
    return false;
  }
}

module.exports = { buildCommand, notify };
