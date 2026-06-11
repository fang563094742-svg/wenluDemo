#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT/.taskline_artifacts/chess_wait_state}"
LATEST="$OUTDIR/latest_chess_wait_state.json"
JSON_PATH="$(bash "$ROOT/.wenlu_sensors/chess_wait_state.sh" "$OUTDIR" | tail -n 1 | tr -d '\r')"
cp "$JSON_PATH" "$LATEST"
JSON_PATH="$JSON_PATH" python3 - <<'PY'
import json, os, sys
with open(os.environ['JSON_PATH'], 'r', encoding='utf-8') as fh:
    payload = json.load(fh)
if payload.get('verdict') == 'waiting' and payload.get('blocker') == 'wait-chess-window':
    print(json.dumps({'ok': True, 'json': os.environ['JSON_PATH'], 'verdict': payload['verdict']}, ensure_ascii=False))
    sys.exit(0)
print(json.dumps({'ok': False, 'json': os.environ['JSON_PATH'], 'verdict': payload.get('verdict'), 'blocker': payload.get('blocker')}, ensure_ascii=False))
sys.exit(1)
PY
