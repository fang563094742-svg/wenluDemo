#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
OUTDIR="${VERIFY_OUTDIR:-$ROOT/artifacts/verification}"
NAME="${1:-generic_check}"
VERIFY_CMD="${2:-true}"
mkdir -p "$OUTDIR"
STAMP="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
SAFE_NAME="$(printf '%s' "$NAME" | tr ' /:' '___')"
STDOUT_PATH="$OUTDIR/${SAFE_NAME}_${STAMP}.stdout.txt"
STDERR_PATH="$OUTDIR/${SAFE_NAME}_${STAMP}.stderr.txt"
JSON_PATH="$OUTDIR/${SAFE_NAME}_${STAMP}.json"

set +e
bash -lc "$VERIFY_CMD" >"$STDOUT_PATH" 2>"$STDERR_PATH"
EXIT_CODE=$?
set -e

python3 - <<'PY' "$NAME" "$VERIFY_CMD" "$EXIT_CODE" "$STDOUT_PATH" "$STDERR_PATH" "$JSON_PATH"
import json, sys, pathlib, datetime
name, cmd, exit_code, stdout_path, stderr_path, json_path = sys.argv[1:7]
stdout = pathlib.Path(stdout_path).read_text(errors='replace')
stderr = pathlib.Path(stderr_path).read_text(errors='replace')
result = {
  'ok': int(exit_code) == 0,
  'name': name,
  'verifyCmd': cmd,
  'exitCode': int(exit_code),
  'stdoutPath': stdout_path,
  'stderrPath': stderr_path,
  'stdoutPreview': stdout[:1000],
  'stderrPreview': stderr[:1000],
  'capturedAt': datetime.datetime.utcnow().isoformat() + 'Z',
  'verifier': {
    'name': 'verify_with_evidence',
    'version': 1,
    'deterministicSignals': ['shell exit code', 'captured stdout', 'captured stderr', 'timestamped json envelope']
  }
}
pathlib.Path(json_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
PY

exit "$EXIT_CODE"
