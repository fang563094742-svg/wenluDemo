#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT/.taskline_artifacts/front_app_verify}"
EXPECT_APP="${2:-Chess}"
EXPECT_TITLE_SUBSTR="${3:-}"
mkdir -p "$OUTDIR"

TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
JSON="$OUTDIR/front_app_verify_${TS}.json"
LATEST="$OUTDIR/latest_front_app_verify.json"
TMP_RAW="$OUTDIR/front_app_verify_${TS}.raw.txt"

/usr/bin/osascript <<'APPLESCRIPT' > "$TMP_RAW"
set outputLines to {}
tell application "System Events"
	delay 0.2
	set frontProc to first application process whose frontmost is true
	set end of outputLines to name of frontProc
	try
		set end of outputLines to name of front window of frontProc
	on error
		set end of outputLines to ""
	end try
	set procNames to name of every application process whose background only is false
	set AppleScript's text item delimiters to "|"
	set end of outputLines to (procNames as text)
end tell
set AppleScript's text item delimiters to "\n---\n"
return outputLines as text
APPLESCRIPT

python3 - <<'PY' "$TMP_RAW" "$JSON" "$LATEST" "$EXPECT_APP" "$EXPECT_TITLE_SUBSTR" "$TS"
import json, sys
raw_path, json_path, latest_path, expect_app, expect_substr, ts = sys.argv[1:7]
raw = open(raw_path, 'r', encoding='utf-8', errors='ignore').read().split('\n---\n')
front = raw[0].strip() if len(raw) > 0 else ''
title = raw[1].strip() if len(raw) > 1 else ''
running = [x.strip() for x in (raw[2].split('|') if len(raw) > 2 else []) if x.strip()]
app_ok = front == expect_app
substr_ok = True if not expect_substr else (expect_substr in title)
ok = app_ok and substr_ok
blocker = None
if not app_ok:
    blocker = 'front-app-mismatch'
elif not substr_ok:
    blocker = 'window-title-mismatch'
payload = {
    'capturedAt': ts,
    'expectApp': expect_app,
    'expectTitleSubstring': expect_substr,
    'frontApp': front,
    'windowTitle': title,
    'runningApps': running,
    'ok': ok,
    'blocker': blocker,
    'rawProbeFile': raw_path,
}
for path in (json_path, latest_path):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write('\n')
print(json.dumps(payload, ensure_ascii=False))
sys.exit(0 if ok else 1)
PY
