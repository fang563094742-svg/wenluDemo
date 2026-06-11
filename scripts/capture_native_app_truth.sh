#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="${1:-Chess}"
JSON_PATH="$(bash "$ROOT/native_app_probe/chess_truth_capture.sh" "$APP_NAME" | tail -n 1)"
if [ ! -f "$JSON_PATH" ]; then
  echo "missing truth json: $JSON_PATH" >&2
  exit 1
fi
python3 - "$JSON_PATH" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    payload = json.load(f)
print(json.dumps(payload, ensure_ascii=False, indent=2))
PY
