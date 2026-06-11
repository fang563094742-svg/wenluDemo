#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT_BASE="${1:-/tmp/chess_verification_cases}"
PASS_DIR="$OUT_BASE/pass"
FAIL_DIR="$OUT_BASE/fail"
mkdir -p "$PASS_DIR" "$FAIL_DIR"

PASS_LOG="$PASS_DIR/run.log"
FAIL_LOG="$FAIL_DIR/run.log"

set +e
APP_NAME=Chess bash scripts/verify/chess_verification_evidence_chain.sh "$PASS_DIR" >"$PASS_LOG" 2>&1
PASS_EXIT=$?
set -e

if [ "$PASS_EXIT" -ne 0 ]; then
  echo "expected completed verdict for Chess, got exit $PASS_EXIT"
  cat "$PASS_LOG"
  exit 1
fi

grep -F '"verdict": "completed"' "$PASS_LOG" >/dev/null

grep -F '"completionReasons"' "$PASS_LOG" >/dev/null

set +e
APP_NAME=Chess_NoSuchApp_Probe bash scripts/verify/chess_verification_evidence_chain.sh "$FAIL_DIR" >"$FAIL_LOG" 2>&1
FAIL_EXIT=$?
set -e

if [ "$FAIL_EXIT" -ne 1 ]; then
  echo "expected failed verdict for missing app, got exit $FAIL_EXIT"
  cat "$FAIL_LOG"
  exit 1
fi

grep -F '"verdict": "failed"' "$FAIL_LOG" >/dev/null
grep -F 'app-not-running' "$FAIL_LOG" >/dev/null

echo "chess verification evidence chain accepts pass/fail via $OUT_BASE"
