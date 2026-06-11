#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/.taskline_artifacts/verify_wenlu_frontdoor"
mkdir -p "$OUT_DIR"

SUMMARY_PATH="$(bash "$ROOT/.wenlu_sensors/native_truth_summary.sh" Safari "$OUT_DIR")"
if [ ! -f "$SUMMARY_PATH" ]; then
  echo "missing summary json: $SUMMARY_PATH" >&2
  exit 1
fi

python3 - "$SUMMARY_PATH" <<'PY'
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
payload = json.loads(path.read_text(encoding='utf-8'))
blockers = []
if payload.get('targetApp') != 'Safari':
    blockers.append(f"targetApp={payload.get('targetApp')}")
if payload.get('frontApp') != 'Safari':
    blockers.append(f"frontApp={payload.get('frontApp')}")
if payload.get('isTargetFront') is not True:
    blockers.append('isTargetFront=false')
if payload.get('hasTargetRunning') is not True:
    blockers.append('hasTargetRunning=false')
window_title = payload.get('effectiveWindowTitle') or payload.get('frontWindowTitle') or ''
if '问路' not in window_title:
    blockers.append(f"windowTitle={window_title}")
for key in ['screenCapture', 'windowTitleEvidenceFile', 'evidenceJson']:
    value = payload.get(key)
    if not value or not Path(value).exists():
        blockers.append(f"missing:{key}")
if payload.get('truthSource') != 'native_window_truth.sh':
    blockers.append(f"truthSource={payload.get('truthSource')}")
if blockers:
    print('FAILED ' + '; '.join(blockers))
    sys.exit(1)
print('PASS Safari frontdoor truth verified via ' + str(path))
PY
