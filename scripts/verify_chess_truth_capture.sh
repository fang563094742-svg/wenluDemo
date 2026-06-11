#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(cd "$ROOT" && ./native_app_probe/chess_truth_capture.sh Chess)"
python3 - "$OUT" <<'PY'
import json, os, sys
path=sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    data=json.load(f)
errors=[]
if data.get('targetApp') != 'Chess':
    errors.append('targetApp != Chess')
if not data.get('hasTargetRunning'):
    errors.append('Chess not running')
if not os.path.exists(data.get('screenCapture','')):
    errors.append('screenCapture missing')
if not os.path.exists(path):
    errors.append('json missing')
if data.get('frontApp') == 'Chess' and not data.get('isTargetFront'):
    errors.append('frontApp Chess but isTargetFront false')
if errors:
    print('\n'.join(errors))
    sys.exit(1)
print(json.dumps({
  'verified': True,
  'json': path,
  'frontApp': data.get('frontApp'),
  'windowTitle': data.get('windowTitle'),
  'hasTargetRunning': data.get('hasTargetRunning'),
  'isTargetFront': data.get('isTargetFront')
}, ensure_ascii=False, indent=2))
PY
