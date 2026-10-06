#!/usr/bin/env bash
# Startet die Zeiterfassung lokal (nur auf diesem Rechner erreichbar).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js fehlt. Bitte Version 22 oder neuer von https://nodejs.org installieren."; exit 1
fi
MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 20 ]; then echo "Node.js $MAJOR ist zu alt (benoetigt: 20 oder neuer)."; exit 1; fi
[ -d node_modules ] || { echo "Erster Start: Abhaengigkeiten werden installiert ..."; npm install --omit=dev || exit 1; }
LOCAL_MODE=true OPEN_BROWSER=1 exec node src/server.js
