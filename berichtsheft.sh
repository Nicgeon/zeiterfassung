#!/usr/bin/env bash
# Berichtsheft-Text aus den erfassten Einträgen erzeugen (lokaler Betrieb).
#   ./berichtsheft.sh                 letzte Kalenderwoche
#   ./berichtsheft.sh --von 2026-10-12 --bis 2026-10-18 --kopieren
#   ./berichtsheft.sh hilfe
cd "$(dirname "$0")" || exit 1

for dir in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$dir:"*) ;; *) [ -d "$dir" ] && PATH="$PATH:$dir" ;; esac
done
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js fehlt. Bitte Version 22 oder neuer installieren: https://nodejs.org"; exit 1
fi
[ -d node_modules ] || { echo "Bitte zuerst start-local.sh ausführen (installiert die Abhängigkeiten)."; exit 1; }

export LOCAL_MODE=true
exec node src/scripts/berichtsheft.js "$@"
