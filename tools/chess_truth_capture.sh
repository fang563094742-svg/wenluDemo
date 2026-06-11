#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT_DIR/native_app_probe/evidence}"
mkdir -p "$OUTDIR"
JSON_PATH="$(bash "$ROOT_DIR/native_app_probe/chess_truth_capture.sh" Chess)"
TARGET_PATH="$OUTDIR/$(basename "$JSON_PATH")"
if [ "$JSON_PATH" != "$TARGET_PATH" ]; then
  cp "$JSON_PATH" "$TARGET_PATH"
else
  TARGET_PATH="$JSON_PATH"
fi
python3 - "$TARGET_PATH" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
data = json.loads(p.read_text())
print(json.dumps(data, ensure_ascii=False, indent=2))
PY
