#!/usr/bin/env python3
import json
import sys
from pathlib import Path

if len(sys.argv) != 2:
    print("usage: verify_github_gmail_frontdoor_evidence.py <summary-json>", file=sys.stderr)
    sys.exit(2)

summary_path = Path(sys.argv[1])
if not summary_path.exists():
    print(f"missing summary json: {summary_path}", file=sys.stderr)
    sys.exit(2)

summary = json.loads(summary_path.read_text(encoding='utf-8'))
truth_path = Path(summary.get('truthJsonFile', ''))
latest_truth_path = Path(summary.get('latestTruthJsonFile', ''))

errors = []
if not summary.get('frontApp'):
    errors.append('frontApp-empty')
if not summary.get('frontWindowTitle'):
    errors.append('frontWindowTitle-empty')
if summary.get('frontApp') != 'Safari':
    errors.append('frontApp-not-safari')
if not truth_path.exists():
    errors.append('truth-json-missing')
if not latest_truth_path.exists():
    errors.append('latest-truth-json-missing')
if summary.get('ok') is False and not summary.get('blocker'):
    errors.append('missing-blocker-on-failure')
if summary.get('ok') is True and summary.get('verdict') != 'gmail-verification-mail-front':
    errors.append('success-verdict-mismatch')

result = {
    'ok': len(errors) == 0,
    'summaryPath': str(summary_path),
    'truthPath': str(truth_path),
    'latestTruthPath': str(latest_truth_path),
    'frontApp': summary.get('frontApp'),
    'frontWindowTitle': summary.get('frontWindowTitle'),
    'verdict': summary.get('verdict'),
    'blocker': summary.get('blocker'),
    'errors': errors,
}
print(json.dumps(result, ensure_ascii=False))
sys.exit(0 if result['ok'] else 1)
