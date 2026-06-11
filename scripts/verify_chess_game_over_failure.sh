#!/usr/bin/env bash
set -euo pipefail

TMP_FILE="${TMPDIR:-/tmp}/chess_game_over_probe.json"
rm -f "$TMP_FILE"
set +e
bash chess_acceptance_verify.sh Chess . observe game-over >"$TMP_FILE" 2>&1
CODE=$?
set -e
if [ "$CODE" -eq 0 ]; then
  echo "unexpected-success"
  exit 1
fi
if ! grep -q '"blocker": "game-over-not-detected"' "$TMP_FILE"; then
  echo "missing-blocker"
  cat "$TMP_FILE"
  exit 1
fi
exit 0
