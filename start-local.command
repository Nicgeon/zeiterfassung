#!/usr/bin/env bash
# Doppelklick-Starter fuer macOS: Der Finder oeffnet .command-Dateien im Terminal.
# Beim allerersten Start ggf. per Rechtsklick -> "Oeffnen" bestaetigen (siehe README).
cd "$(dirname "$0")" || exit 1
bash ./start-local.sh
CODE=$?
echo
echo "Die Zeiterfassung wurde beendet (Code $CODE). Dieses Fenster kann geschlossen werden."
