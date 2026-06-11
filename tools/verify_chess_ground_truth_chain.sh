#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="${1:-Chess}"
if [ "$APP_NAME" != "Chess" ]; then
  echo "This verifier is specialized for Chess; got: $APP_NAME" >&2
  exit 2
fi
JSON_PATH="$(bash "$ROOT_DIR/native_app_probe/chess_truth_capture.sh" "$APP_NAME")"
python3 - "$JSON_PATH" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
data = json.loads(p.read_text())
assert data.get('targetApp') == 'Chess', data.get('targetApp')
assert data.get('frontApp') == 'Chess', data.get('frontApp')
assert data.get('isTargetFront') is True
assert data.get('hasTargetRunning') is True
assert isinstance(data.get('windowTitle'), str)
assert data.get('screenCapture') and pathlib.Path(data['screenCapture']).exists(), data.get('screenCapture')
assert 'capturedAt' in data and data['capturedAt']
print(json.dumps({
    'ok': True,
    'json': str(p),
    'frontApp': data.get('frontApp'),
    'windowTitle': data.get('windowTitle'),
    'screenCapture': data.get('screenCapture'),
    'ocrStatus': data.get('ocrStatus')
}, ensure_ascii=False))
PY
