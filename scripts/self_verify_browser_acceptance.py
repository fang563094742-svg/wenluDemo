#!/usr/bin/env python3
import json
import subprocess
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
OUTDIR = ROOT / 'verification_primitives' / 'browser_selfcheck'
OUTDIR.mkdir(parents=True, exist_ok=True)
TS = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ')
RESULT = OUTDIR / f'browser_acceptance_selfcheck_{TS}.json'
LATEST = OUTDIR / 'latest_browser_acceptance_selfcheck.json'

cases = [
    {
        'name': 'stable_fail_github_access',
        'cmd': ['bash', str(ROOT / 'scripts/verify_browser_frontdoor_chain.sh'), str(OUTDIR), 'Safari', 'github-access-settings-front'],
        'expectExit': 1,
        'expectation': 'github-access-settings-front',
        'expectedOutcome': 'fail',
        'allowedBlockers': ['browser-not-running', 'browser-state-unreadable', 'browser-not-front', 'browser-front-url-missing', 'gmail-front-not-github-access', 'front-page-not-target'],
    },
    {
        'name': 'stable_fail_local_frontdoor',
        'cmd': ['bash', str(ROOT / 'scripts/verify_browser_frontdoor_chain.sh'), str(OUTDIR), 'Safari', 'local-frontdoor-front'],
        'expectExit': 1,
        'expectation': 'local-frontdoor-front',
        'expectedOutcome': 'fail',
        'allowedBlockers': ['browser-not-running', 'browser-state-unreadable', 'browser-not-front', 'browser-front-url-missing', 'front-page-not-target'],
    },
]

results = []
all_ok = True
for case in cases:
    proc = subprocess.run(case['cmd'], capture_output=True, text=True)
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    summary_json = Path(lines[-1]) if lines else None
    case_ok = proc.returncode == case['expectExit'] and summary_json is not None and summary_json.exists()
    verify_rc = None
    verify_stdout = ''
    verify_stderr = ''
    if case_ok:
        verify = subprocess.run([
            'python3', str(ROOT / 'scripts/verify_browser_acceptance_chain.py'), 'Safari', str(OUTDIR), case['expectation'], case['expectedOutcome'], str(summary_json), *case['allowedBlockers']
        ], capture_output=True, text=True)
        verify_rc = verify.returncode
        verify_stdout = verify.stdout
        verify_stderr = verify.stderr
        case_ok = case_ok and verify.returncode == 0
    else:
        case_ok = False
    all_ok = all_ok and case_ok
    results.append({
        'name': case['name'],
        'command': case['cmd'],
        'returncode': proc.returncode,
        'expectedReturncode': case['expectExit'],
        'summaryJson': str(summary_json) if summary_json else '',
        'verifyReturncode': verify_rc,
        'verifyStdout': verify_stdout,
        'verifyStderr': verify_stderr,
        'ok': case_ok,
        'stdout': proc.stdout,
        'stderr': proc.stderr,
    })

payload = {
    'capturedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'ok': all_ok,
    'cases': results,
}
RESULT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
LATEST.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(payload, ensure_ascii=False))
raise SystemExit(0 if all_ok else 1)
