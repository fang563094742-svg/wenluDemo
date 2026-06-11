#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p artifacts/chess_framework_verify
node scripts/chess_midgame_framework.mjs --outdir artifacts/chess_framework_verify >/tmp/chess_framework_verify_stdout.json
python3 - <<'PY'
import json, pathlib
p = pathlib.Path('artifacts/chess_framework_verify/midgame_framework_result.json')
data = json.loads(p.read_text())
assert data['frontApp'] == 'Chess', data['frontApp']
assert data['ocrStatus'] in ('ok','failed','skipped'), data['ocrStatus']
assert pathlib.Path(data['truthPath']).exists(), data['truthPath']
assert pathlib.Path(data['imagePath']).exists(), data['imagePath']
assert isinstance(data['candidatePlans'], list) and len(data['candidatePlans']) > 0
first = data['candidatePlans'][0]
assert 'move' in first and first['move']
assert 'contingency' in first and isinstance(first['contingency'], list)
print(json.dumps({
  'ok': True,
  'summary': data['summary'],
  'source': data['source'],
  'ocrStatus': data['ocrStatus'],
  'firstMove': first['move'],
  'truthPath': data['truthPath']
}, ensure_ascii=False))
PY
