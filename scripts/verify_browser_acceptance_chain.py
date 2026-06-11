#!/usr/bin/env python3
import json
import subprocess
import sys
from pathlib import Path


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def assert_summary(path: Path, expectation: str, expect_ok: bool, allowed_blockers: set[str]) -> None:
    payload = load_json(path)
    if payload.get('expectation') != expectation:
        raise AssertionError(f'expectation_mismatch:{payload.get("expectation")}')
    if bool(payload.get('ok', False)) != expect_ok:
        raise AssertionError(f'ok_mismatch:{payload.get("ok")}')
    truth_path = Path(payload.get('truthJsonFile', ''))
    if not truth_path.exists():
        raise AssertionError('truth_json_missing')
    browser = payload.get('browser', {}) or {}
    if not browser.get('appName'):
        raise AssertionError('browser_app_missing')
    if expect_ok:
        if not payload.get('verdict') or payload.get('verdict') != expectation:
            raise AssertionError(f'verdict_mismatch:{payload.get("verdict")}')
        if payload.get('blocker'):
            raise AssertionError(f'unexpected_blocker:{payload.get("blocker")}')
    else:
        blocker = payload.get('blocker', '')
        if not blocker:
            raise AssertionError('missing_blocker')
        if allowed_blockers and blocker not in allowed_blockers:
            raise AssertionError(f'blocker_not_allowed:{blocker}')


if __name__ == '__main__':
    if len(sys.argv) < 6:
        print('usage: verify_browser_acceptance_chain.py TARGET_BROWSER OUTDIR EXPECTATION pass|fail SUMMARY_JSON [ALLOWED_BLOCKER...]', file=sys.stderr)
        raise SystemExit(2)
    target_browser = sys.argv[1]
    outdir = Path(sys.argv[2])
    expectation = sys.argv[3]
    expected_outcome = sys.argv[4]
    summary_json = Path(sys.argv[5])
    allowed_blockers = set(sys.argv[6:])
    expect_ok = expected_outcome == 'pass'
    assert_summary(summary_json, expectation, expect_ok, allowed_blockers)
    print(json.dumps({
        'targetBrowser': target_browser,
        'outDir': str(outdir),
        'expectation': expectation,
        'expectedOutcome': expected_outcome,
        'summaryJson': str(summary_json),
        'allowedBlockers': sorted(allowed_blockers),
        'ok': True,
    }, ensure_ascii=False))
