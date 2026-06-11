#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/.taskline_artifacts/github_gmail_frontdoor_capture}"
mkdir -p "$OUT_DIR"

VERIFY_OUTPUT="$(bash "$ROOT/scripts/verify_github_gmail_frontdoor.sh" "$OUT_DIR" 2>&1 || true)"
SUMMARY_JSON="$OUT_DIR/latest_github_gmail_frontdoor_summary.json"
TRUTH_JSON="$OUT_DIR/latest_github_gmail_frontdoor_truth.json"
ASSERT_JSON="$OUT_DIR/latest_github_gmail_frontdoor_assert.json"

export SUMMARY_JSON TRUTH_JSON ASSERT_JSON VERIFY_OUTPUT
python3 - <<'PY'
import json, os, sys
from pathlib import Path

summary_path = Path(os.environ['SUMMARY_JSON'])
truth_path = Path(os.environ['TRUTH_JSON'])
assert_path = Path(os.environ['ASSERT_JSON'])
verify_output = os.environ.get('VERIFY_OUTPUT', '')

errors = []
summary = {}
truth = {}
if not summary_path.exists():
    errors.append('missing-summary-json')
else:
    summary = json.loads(summary_path.read_text(encoding='utf-8'))
if not truth_path.exists():
    errors.append('missing-truth-json')
else:
    truth = json.loads(truth_path.read_text(encoding='utf-8'))

if summary:
    if not summary.get('frontApp'):
        errors.append('frontApp-empty')
    if not summary.get('blocker') and not summary.get('ok'):
        errors.append('missing-blocker-on-failure')
    if summary.get('frontApp') != truth.get('frontApp'):
        errors.append('frontApp-mismatch-between-summary-and-truth')
    if summary.get('frontWindowTitle') != truth.get('frontWindowTitle'):
        errors.append('frontWindow-mismatch-between-summary-and-truth')

result = {
    'ok': len(errors) == 0,
    'summaryPath': str(summary_path),
    'truthPath': str(truth_path),
    'frontApp': summary.get('frontApp'),
    'frontWindowTitle': summary.get('frontWindowTitle'),
    'blocker': summary.get('blocker'),
    'verdict': summary.get('verdict'),
    'verifyOutput': verify_output,
    'errors': errors,
}
assert_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
sys.exit(0 if result['ok'] else 1)
PY
