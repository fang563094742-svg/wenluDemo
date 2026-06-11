#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/.taskline_artifacts/browser_frontdoor}"
TARGET_BROWSER="${2:-Safari}"
EXPECTATION="${3:-github-access-settings-front}"
mkdir -p "$OUT_DIR"

TRUTH_OUTPUT="$(bash "$ROOT/.wenlu_sensors/browser_front_truth.sh" "$OUT_DIR")"
TRUTH_JSON="$(printf '%s\n' "$TRUTH_OUTPUT" | tail -n 1)"
LATEST_TRUTH="$OUT_DIR/latest_browser_front_truth.json"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
SUMMARY_JSON="$OUT_DIR/browser_frontdoor_summary_${TS}.json"
LATEST_SUMMARY="$OUT_DIR/latest_browser_frontdoor_summary.json"

set +e
python3 "$ROOT/scripts/browser_acceptance_summary.py" "$TRUTH_JSON" "$LATEST_TRUTH" "$SUMMARY_JSON" "$TARGET_BROWSER" "$EXPECTATION"
RC=$?
set -e
cp "$SUMMARY_JSON" "$LATEST_SUMMARY"
echo "$SUMMARY_JSON"
exit $RC
