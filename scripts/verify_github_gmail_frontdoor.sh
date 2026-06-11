#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/.taskline_artifacts/github_gmail_frontdoor_verify}"
mkdir -p "$OUT_DIR"

TRUTH_OUTPUT="$(bash "$ROOT/.wenlu_sensors/github_gmail_frontdoor_truth.sh" "$OUT_DIR")"
TRUTH_JSON="$(printf '%s\n' "$TRUTH_OUTPUT" | tail -n 1)"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
SUMMARY_JSON="$OUT_DIR/github_gmail_frontdoor_summary_${TS}.json"
LATEST_SUMMARY="$OUT_DIR/latest_github_gmail_frontdoor_summary.json"
LATEST_TRUTH="$OUT_DIR/latest_github_gmail_frontdoor_truth.json"

export TRUTH_JSON SUMMARY_JSON LATEST_TRUTH
python3 - <<'PY'
import json, os, sys
from pathlib import Path

truth_path = Path(os.environ['TRUTH_JSON'])
summary_path = Path(os.environ['SUMMARY_JSON'])
latest_truth = Path(os.environ['LATEST_TRUTH'])
payload = json.loads(truth_path.read_text(encoding='utf-8'))
signals = payload.get('signals', {})
summary = {
    'capturedAt': payload.get('capturedAt'),
    'truthJsonFile': str(truth_path),
    'latestTruthJsonFile': str(latest_truth),
    'frontApp': payload.get('frontApp', ''),
    'frontWindowTitle': payload.get('frontWindowTitle', ''),
    'safariFrontTitle': payload.get('safariFrontTitle', ''),
    'safariFrontURL': payload.get('safariFrontURL', ''),
    'scene': payload.get('scene', 'unknown'),
    'signals': signals,
    'ok': False,
    'blocker': '',
    'verdict': ''
}

if not signals.get('safariRunning'):
    summary['blocker'] = 'safari-not-running'
    summary['verdict'] = 'blocked'
elif not signals.get('safariFront'):
    summary['blocker'] = 'safari-not-front'
    summary['verdict'] = 'blocked'
elif signals.get('gmailVerificationMail'):
    summary['ok'] = True
    summary['verdict'] = 'gmail-verification-mail-front'
elif signals.get('gmailInboxPage'):
    summary['blocker'] = 'gmail-front-not-verification-mail'
    summary['verdict'] = 'blocked'
elif signals.get('githubAccessPage'):
    summary['blocker'] = 'github-access-front-not-gmail'
    summary['verdict'] = 'blocked'
else:
    summary['blocker'] = 'safari-front-unexpected-page'
    summary['verdict'] = 'blocked'

summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
Path(os.environ['SUMMARY_JSON']).replace(Path(os.environ['SUMMARY_JSON']))
latest_summary = summary_path.parent / 'latest_github_gmail_frontdoor_summary.json'
latest_summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False))
sys.exit(0 if summary['ok'] else 1)
PY

cp "$SUMMARY_JSON" "$LATEST_SUMMARY"
echo "$SUMMARY_JSON"
