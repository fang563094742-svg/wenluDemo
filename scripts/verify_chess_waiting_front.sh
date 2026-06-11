#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT/.taskline_artifacts/chess_wait_front_verifier}"
mkdir -p "$OUTDIR"

TRUTH_JSON="$OUTDIR/front_truth.json"
WAIT_STDOUT="$OUTDIR/wait.stdout.json"
WAIT_STDERR="$OUTDIR/wait.stderr.txt"
SUMMARY_JSON="$OUTDIR/summary.json"

python3 - <<'PY' > "$TRUTH_JSON"
import json, subprocess
script = '''
tell application "System Events"
set frontProc to first process whose frontmost is true
set frontName to name of frontProc
set windowTitle to ""
try
if (count of windows of frontProc) > 0 then set windowTitle to name of front window of frontProc
end try
set appNames to name of every process whose background only is false
set AppleScript's text item delimiters to "|"
set appNamesText to appNames as text
return frontName & linefeed & windowTitle & linefeed & appNamesText
end tell
'''
raw = subprocess.check_output(["osascript", "-e", script], text=True)
parts = raw.splitlines()
front = parts[0] if len(parts) > 0 else ""
window = parts[1] if len(parts) > 1 else ""
running_raw = parts[2] if len(parts) > 2 else ""
running = [x.strip() for x in running_raw.split('|') if x.strip()]
print(json.dumps({
    "frontApp": front,
    "windowTitle": window,
    "runningApps": running,
}, ensure_ascii=False))
PY

bash "$ROOT/scripts/verify_chess_waiting.sh" "$OUTDIR/wait_case" >"$WAIT_STDOUT" 2>"$WAIT_STDERR"

TRUTH_JSON="$TRUTH_JSON" WAIT_STDOUT="$WAIT_STDOUT" SUMMARY_JSON="$SUMMARY_JSON" python3 - <<'PY'
import json, os, sys
with open(os.environ['TRUTH_JSON'], 'r', encoding='utf-8') as fh:
    truth = json.load(fh)
with open(os.environ['WAIT_STDOUT'], 'r', encoding='utf-8') as fh:
    wait = json.load(fh)
ok = (
    truth.get('frontApp') == 'Chess' and
    'Chess' in truth.get('runningApps', []) and
    truth.get('windowTitle', '') == '' and
    wait.get('ok') is True and
    wait.get('verdict') == 'waiting'
)
summary = {
    'ok': ok,
    'frontApp': truth.get('frontApp'),
    'windowTitle': truth.get('windowTitle'),
    'runningApps': truth.get('runningApps', []),
    'waitVerdict': wait.get('verdict'),
    'waitJson': wait.get('json'),
    'blocker': '' if ok else 'front-truth-and-wait-verdict-mismatch',
}
with open(os.environ['SUMMARY_JSON'], 'w', encoding='utf-8') as fh:
    json.dump(summary, fh, ensure_ascii=False, indent=2)
print(json.dumps(summary, ensure_ascii=False))
sys.exit(0 if ok else 1)
PY
