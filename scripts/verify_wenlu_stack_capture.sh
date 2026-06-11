#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.taskline_artifacts/wenlu_stack_verify"
mkdir -p "$OUT"
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
STDOUT_FILE="$OUT/verify_${TS}.stdout"
STDERR_FILE="$OUT/verify_${TS}.stderr"
JSON_FILE="$OUT/verify_${TS}.json"
LATEST_FILE="$OUT/latest_verify.json"
if bash "$ROOT/scripts/verify_wenlu_stack.sh" >"$STDOUT_FILE" 2>"$STDERR_FILE"; then
  STATUS="pass"
  EXIT_CODE=0
else
  EXIT_CODE=$?
  STATUS="fail"
fi
printf '{\n  "capturedAt": "%s",\n  "status": "%s",\n  "exitCode": %s,\n  "stdoutFile": "%s",\n  "stderrFile": "%s"\n}\n' \
  "$TS" "$STATUS" "$EXIT_CODE" "$STDOUT_FILE" "$STDERR_FILE" | tee "$JSON_FILE" > "$LATEST_FILE"
exit "$EXIT_CODE"
