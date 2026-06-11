#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT_DIR/artifacts/chess_truth_chain}"
mkdir -p "$OUTDIR"
INSPECT_BEFORE="$OUTDIR/inspect_before.json"
INSPECT_AFTER="$OUTDIR/inspect_after.json"
CAPTURE_STDOUT="$OUTDIR/capture_stdout.json"
FINAL_JSON="$OUTDIR/latest_capture.json"

python3 - <<'PY' > "$INSPECT_BEFORE"
import json, subprocess
raw = subprocess.check_output(['osascript','-e','tell application "System Events" to get name of first application process whose frontmost is true'], text=True).strip()
print(json.dumps({'frontApp': raw}, ensure_ascii=False, indent=2))
PY

osascript -e 'tell application "Chess" to activate'
sleep 1

python3 - <<'PY' > "$INSPECT_AFTER"
import json, subprocess
front = subprocess.check_output(['osascript','-e','tell application "System Events" to get name of first application process whose frontmost is true'], text=True).strip()
try:
    title = subprocess.check_output(['osascript','-e',f'tell application "System Events" to tell process "{front}" to get value of attribute "AXTitle" of front window'], text=True).strip()
except subprocess.CalledProcessError:
    title = ''
print(json.dumps({'frontApp': front, 'windowTitle': title}, ensure_ascii=False, indent=2))
PY

JSON_PATH="$(bash "$ROOT_DIR/native_app_probe/chess_truth_capture.sh" Chess)"
printf '%s\n' "$JSON_PATH" > "$CAPTURE_STDOUT"
cp "$JSON_PATH" "$FINAL_JSON"
cat "$FINAL_JSON"
