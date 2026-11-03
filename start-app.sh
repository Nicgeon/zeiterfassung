#!/usr/bin/env bash
# Startet die Zeiterfassung als Programm (lokal): unsichtbar im Hintergrund + eigenes App-Fenster.
# Ausgaben: <Datenordner>/zeiterfassung.log. Unter macOS startet Zeiterfassung.app dieses Skript.
cd "$(dirname "$0")" || exit 1

# macOS: Homebrew-Node liegt oft nicht im PATH, wenn kein Terminal-Profil geladen wurde.
for dir in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$dir:"*) ;; *) [ -d "$dir" ] && PATH="$PATH:$dir" ;; esac
done

if ! command -v node >/dev/null 2>&1; then
  MSG="Node.js fehlt. Bitte Version 22 oder neuer installieren: https://nodejs.org (oder: brew install node)."
  if [ "$(uname)" = "Darwin" ]; then
    osascript -e "display dialog \"$MSG\" with title \"Zeiterfassung\" buttons {\"OK\"} default button \"OK\"" >/dev/null 2>&1
  else
    echo "$MSG" >&2
    command -v zenity >/dev/null 2>&1 && zenity --error --title "Zeiterfassung" --text "$MSG"
  fi
  exit 1
fi

export LOCAL_MODE=true
exec node src/launcher.js "$@"
