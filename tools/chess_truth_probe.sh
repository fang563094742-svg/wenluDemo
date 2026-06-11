#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="${1:-Chess}"
JSON_PATH="$($ROOT_DIR/native_app_probe/chess_truth_capture.sh "$APP_NAME")"
python3 - "$JSON_PATH" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)
summary = {
    'capturedAt': data.get('capturedAt'),
    'targetApp': data.get('targetApp'),
    'frontApp': data.get('frontApp'),
    'isTargetFront': data.get('isTargetFront'),
    'hasTargetRunning': data.get('hasTargetRunning'),
    'windowTitle': data.get('windowTitleEvidence') or data.get('windowTitle'),
    'screenCapture': data.get('screenCapture'),
    'ocrStatus': data.get('ocrStatus'),
    'evidenceJson': path,
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
PY
