#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT_DIR/artifacts/chess_truth_chain_verify}"
mkdir -p "$OUTDIR"
JSON_FILE="$OUTDIR/latest_capture.json"
bash "$ROOT_DIR/tools/chess_focus_and_capture.sh" "$OUTDIR" | tee "$JSON_FILE" >/dev/null
python3 - "$JSON_FILE" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
data = json.loads(p.read_text())
assert data.get('frontApp') == 'Chess', f"frontApp={data.get('frontApp')}"
assert data.get('targetApp') == 'Chess', data.get('targetApp')
assert data.get('isTargetFront') is True, data
assert data.get('hasTargetRunning') is True, data
assert isinstance(data.get('windowTitle'), str) and data.get('windowTitle'), data
assert data.get('windowTitleEvidenceFile') and pathlib.Path(data['windowTitleEvidenceFile']).exists(), data.get('windowTitleEvidenceFile')
assert pathlib.Path(data.get('screenCapture','')).exists(), data.get('screenCapture')
print('OK', p)
PY
