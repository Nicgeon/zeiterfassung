#!/usr/bin/env bash
# Doppelklick-Starter fuer macOS (siehe start-local.command): erzeugt den Berichtsheft-Text.
cd "$(dirname "$0")" || exit 1
bash ./berichtsheft.sh "$@"
CODE=$?
echo
echo "Fertig (Code $CODE). Dieses Fenster kann geschlossen werden."
