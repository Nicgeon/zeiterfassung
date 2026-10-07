#!/usr/bin/env bash
# Startet die Zeiterfassung lokal (nur auf diesem Rechner erreichbar).
# Nach einem Update beendet sich die Anwendung mit Code 75 und wird hier neu gestartet.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js fehlt. Bitte Version 22 oder neuer von https://nodejs.org installieren."; exit 1
fi
MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 20 ]; then echo "Node.js $MAJOR ist zu alt (benoetigt: 20 oder neuer)."; exit 1; fi

export LOCAL_MODE=true ZEIT_SUPERVISED=1
OPEN=1
while true; do
  [ -d node_modules ] || { echo "Erster Start: Abhaengigkeiten werden installiert ..."; npm install --omit=dev || exit 1; }
  # Ein Update hat Abhaengigkeiten geaendert: vor dem Start installieren.
  if [ -f .update-install-pending ]; then
    echo "Update: Abhaengigkeiten werden installiert ..."
    npm install --omit=dev || exit 1
    rm -f .update-install-pending
  fi
  # Native Module (better-sqlite3) gelten nur fuer die Node-Version, mit der sie installiert wurden.
  # Wechselt die Version, wird das Modul automatisch neu gebaut.
  if ! node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
    echo "Node.js-Version hat sich geaendert - better-sqlite3 wird neu gebaut ..."
    npm rebuild better-sqlite3
    if ! node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
      echo "Das hat nicht geklappt. Bitte den Ordner node_modules loeschen und start-local.sh erneut starten."; exit 1
    fi
  fi
  OPEN_BROWSER=$OPEN node src/server.js
  CODE=$?
  [ "$CODE" -eq 75 ] || exit "$CODE"
  echo "Neustart nach Update ..."
  OPEN=0
done
