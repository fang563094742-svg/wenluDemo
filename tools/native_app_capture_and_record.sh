#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT_DIR/native_app_probe/evidence}"
mkdir -p "$OUTDIR"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SAFE_TS="${TS//:/-}"
JSON_FILE="$OUTDIR/native_app_truth_${SAFE_TS}.json"
PNG_FILE="$OUTDIR/native_app_front_${SAFE_TS}.png"
RAW_FILE="$OUTDIR/native_app_truth_${SAFE_TS}.raw.json"

INSPECT_RAW=$(python3 - <<'PY'
import json, subprocess
script = 'tell application "System Events"\nset frontProc to first application process whose frontmost is true\nset frontName to name of frontProc\ntry\nset winTitle to value of attribute "AXTitle" of front window of frontProc\non error\nset winTitle to ""\nend try\nset appNames to name of (application processes where background only is false)\nreturn {frontName, winTitle, appNames}\nend tell'
out = subprocess.check_output(["osascript", "-e", script], text=True)
parts = [p.strip() for p in out.strip().split(',')]
front = parts[0] if parts else ''
window = parts[1] if len(parts) > 1 else ''
running = parts[2:] if len(parts) > 2 else []
print(json.dumps({"frontApp": front, "windowTitle": window, "runningApps": running}, ensure_ascii=False))
PY
)
printf '%s\n' "$INSPECT_RAW" > "$RAW_FILE"
printf '%s\n' "$INSPECT_RAW" > "$JSON_FILE"
if command -v screencapture >/dev/null 2>&1; then
  screencapture -x "$PNG_FILE" || true
fi

python3 - "$JSON_FILE" "$TS" "$PNG_FILE" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
ts, png = sys.argv[2:4]
data = json.loads(path.read_text())
data.update({
  'capturedAt': ts,
  'screenCapture': png if pathlib.Path(png).exists() else '',
  'evidenceKind': 'native-app-truth'
})
path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
print(json.dumps(data, ensure_ascii=False, indent=2))
PY
