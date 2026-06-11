#!/usr/bin/env python3
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path('/Users/a333/Desktop/问路唯一开发的文件夹/wenLuDemo')
OUT = ROOT / '.taskline_artifacts' / 'browser_frontdoor_v3_verify'
OUT.mkdir(parents=True, exist_ok=True)

cmd = ['bash', 'scripts/capture_github_gmail_frontdoor_blocker.sh', str(OUT)]
proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)

summary_path = OUT / 'latest_github_gmail_frontdoor_summary.json'
truth_path = OUT / 'latest_github_gmail_frontdoor_truth.json'
assert_path = OUT / 'latest_github_gmail_frontdoor_assert.json'

errors = []
summary = {}
truth = {}
assert_data = {}
if not summary_path.exists():
    errors.append('missing-summary-json')
else:
    summary = json.loads(summary_path.read_text(encoding='utf-8'))
if not truth_path.exists():
    errors.append('missing-truth-json')
else:
    truth = json.loads(truth_path.read_text(encoding='utf-8'))
if not assert_path.exists():
    errors.append('missing-assert-json')
else:
    assert_data = json.loads(assert_path.read_text(encoding='utf-8'))

if proc.returncode != 0:
    errors.append('capture-script-should-self-succeed-with-assert-json')
if summary.get('ok') is not False:
    errors.append('summary-not-blocked')
if summary.get('blocker') != 'safari-not-front':
    errors.append('unexpected-blocker')
if truth.get('frontApp') != 'Electron':
    errors.append('unexpected-front-app')
if assert_data.get('ok') is not True:
    errors.append('assert-layer-failed')

result = {
    'ok': len(errors) == 0,
    'captureReturnCode': proc.returncode,
    'stdout': proc.stdout,
    'stderr': proc.stderr,
    'summaryPath': str(summary_path),
    'truthPath': str(truth_path),
    'assertPath': str(assert_path),
    'blocker': summary.get('blocker'),
    'frontApp': truth.get('frontApp'),
    'errors': errors,
}
latest = OUT / 'latest_browser_frontdoor_v3_verify.json'
latest.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
sys.exit(0 if result['ok'] else 1)
