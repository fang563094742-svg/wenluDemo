#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT/.taskline_artifacts/chess_wait_state_dual}"
mkdir -p "$OUTDIR"
SUCCESS_STDOUT="$OUTDIR/success.stdout.json"
SUCCESS_STDERR="$OUTDIR/success.stderr.txt"
FAIL_STDOUT="$OUTDIR/failure.stdout.json"
FAIL_STDERR="$OUTDIR/failure.stderr.txt"

bash "$ROOT/scripts/verify_chess_waiting.sh" "$OUTDIR/success_case" >"$SUCCESS_STDOUT" 2>"$SUCCESS_STDERR"
python3 - "$SUCCESS_STDOUT" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as fh:
    payload = json.load(fh)
assert payload.get('ok') is True, payload
assert payload.get('verdict') == 'waiting', payload
PY

set +e
JSON_PATH="$OUTDIR/mutated_wait_state.json" python3 - <<'PY' >"$FAIL_STDOUT" 2>"$FAIL_STDERR"
import json, os, sys
src = os.path.join(os.path.dirname(os.environ['JSON_PATH']), 'success_case', 'latest_chess_wait_state.json')
with open(src, 'r', encoding='utf-8') as fh:
    payload = json.load(fh)
payload['verdict'] = 'ready-board-visible'
payload['blocker'] = ''
with open(os.environ['JSON_PATH'], 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, ensure_ascii=False)
print(json.dumps({'ok': False, 'json': os.environ['JSON_PATH'], 'verdict': payload['verdict'], 'blocker': payload['blocker']}, ensure_ascii=False))
sys.exit(1)
PY
FAIL_RC=$?
set -e

python3 - "$FAIL_STDOUT" "$FAIL_RC" <<'PY'
import json, sys
path, rc = sys.argv[1], int(sys.argv[2])
with open(path, 'r', encoding='utf-8') as fh:
    payload = json.load(fh)
assert rc == 1, rc
assert payload.get('ok') is False, payload
assert payload.get('verdict') == 'ready-board-visible', payload
PY

echo "dual-sample-ok"
