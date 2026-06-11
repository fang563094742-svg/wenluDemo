#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT_DIR/native_app_probe/evidence}"
mkdir -p "$OUTDIR"
JSON_PATH="$(bash "$ROOT_DIR/native_app_probe/chess_truth_capture.sh" Chess)"
python3 - "$JSON_PATH" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
data = json.loads(p.read_text())
assert data.get('frontApp') == 'Chess', f"frontApp={data.get('frontApp')}"
assert data.get('targetApp') == 'Chess', data.get('targetApp')
assert data.get('isTargetFront') is True, data
assert data.get('hasTargetRunning') is True, data
assert 'windowTitle' in data and isinstance(data['windowTitle'], str) and data['windowTitle'], data.get('windowTitle')
assert data.get('windowTitleEvidenceFile') and pathlib.Path(data['windowTitleEvidenceFile']).exists(), data.get('windowTitleEvidenceFile')
assert data.get('screenCapture') and pathlib.Path(data['screenCapture']).exists(), data.get('screenCapture')
print('OK', p)
PY
