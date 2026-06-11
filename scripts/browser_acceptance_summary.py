#!/usr/bin/env python3
import json
import sys
from pathlib import Path
from datetime import datetime, timezone


def load_truth(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def normalize_browser_entry(truth: dict, browser_name: str) -> dict:
    browsers = truth.get('browsers', {}) or {}
    entry = browsers.get(browser_name, {}) or {}
    signals = entry.get('signals', {}) or {}
    return {
        'appName': browser_name,
        'running': bool(entry.get('running', False)),
        'appleEventsReadable': bool(entry.get('appleEventsReadable', False)),
        'frontTitle': entry.get('frontTitle', '') or '',
        'frontURL': entry.get('frontURL', '') or '',
        'windowCount': int(entry.get('windowCount', 0) or 0),
        'frontTabCount': int(entry.get('frontTabCount', 0) or 0),
        'signals': {
            'githubAccessSettings': bool(signals.get('githubAccessSettings', False)),
            'gmailInbox': bool(signals.get('gmailInbox', False)),
            'localFrontdoor': bool(signals.get('localFrontdoor', False)),
        },
    }


def build_summary(truth: dict, truth_path: Path, latest_truth_path: Path, target_browser: str, expectation: str) -> tuple[dict, int]:
    front_app = truth.get('frontApp', '') or ''
    browser = normalize_browser_entry(truth, target_browser)
    summary = {
        'capturedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'truthJsonFile': str(truth_path),
        'latestTruthJsonFile': str(latest_truth_path),
        'expectation': expectation,
        'targetBrowser': target_browser,
        'frontApp': front_app,
        'frontWindowTitle': truth.get('frontWindowTitle', '') or '',
        'runningApps': truth.get('runningApps', []) or [],
        'browser': browser,
        'ok': False,
        'verdict': 'blocked',
        'blocker': '',
    }

    if not browser['running']:
        summary['blocker'] = 'browser-not-running'
        return summary, 1
    if not browser['appleEventsReadable']:
        summary['blocker'] = 'browser-state-unreadable'
        return summary, 1
    if front_app != target_browser:
        summary['blocker'] = 'browser-not-front'
        return summary, 1
    if not browser['frontURL']:
        summary['blocker'] = 'browser-front-url-missing'
        return summary, 1

    if expectation == 'github-access-settings-front':
        if browser['signals']['githubAccessSettings']:
            summary['ok'] = True
            summary['verdict'] = 'github-access-settings-front'
            return summary, 0
        if browser['signals']['gmailInbox']:
            summary['blocker'] = 'gmail-front-not-github-access'
        else:
            summary['blocker'] = 'front-page-not-target'
        return summary, 1

    if expectation == 'gmail-inbox-front':
        if browser['signals']['gmailInbox']:
            summary['ok'] = True
            summary['verdict'] = 'gmail-inbox-front'
            return summary, 0
        if browser['signals']['githubAccessSettings']:
            summary['blocker'] = 'github-front-not-gmail'
        else:
            summary['blocker'] = 'front-page-not-target'
        return summary, 1

    if expectation == 'local-frontdoor-front':
        if browser['signals']['localFrontdoor']:
            summary['ok'] = True
            summary['verdict'] = 'local-frontdoor-front'
            return summary, 0
        summary['blocker'] = 'front-page-not-target'
        return summary, 1

    summary['blocker'] = 'unsupported-expectation'
    summary['verdict'] = 'error'
    return summary, 1


if __name__ == '__main__':
    if len(sys.argv) != 6:
        print('usage: browser_acceptance_summary.py TRUTH_JSON LATEST_TRUTH_JSON SUMMARY_JSON TARGET_BROWSER EXPECTATION', file=sys.stderr)
        raise SystemExit(2)
    truth_path = Path(sys.argv[1])
    latest_truth_path = Path(sys.argv[2])
    summary_path = Path(sys.argv[3])
    target_browser = sys.argv[4]
    expectation = sys.argv[5]
    summary, rc = build_summary(load_truth(truth_path), truth_path, latest_truth_path, target_browser, expectation)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))
    raise SystemExit(rc)
