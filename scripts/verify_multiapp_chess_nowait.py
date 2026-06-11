#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys

out = pathlib.Path('.taskline_artifacts/verification')
out.mkdir(parents=True, exist_ok=True)

inspect = subprocess.run([
    'osascript', '-e', 'tell application "System Events" to get name of first application process whose frontmost is true'
], capture_output=True, text=True)
front = inspect.stdout.strip()

run_apps_raw = subprocess.run([
    'osascript', '-e', 'tell application "System Events" to get name of every application process whose background only is false'
], capture_output=True, text=True)
running = [x.strip() for x in run_apps_raw.stdout.split(',') if x.strip()]

truth = subprocess.run(['bash', '.wenlu_sensors/chess_truth_chain.sh', 'Chess'], capture_output=True, text=True)
truth_stdout = truth.stdout.strip()
try:
    candidate = pathlib.Path(truth_stdout.splitlines()[-1])
    if candidate.exists():
        truth_json = json.loads(candidate.read_text())
    else:
        truth_json = json.loads(truth_stdout)
except Exception as e:
    result = {
        'ok': False,
        'blocker': 'truth-parse-failed',
        'frontApp': front,
        'runningApps': running,
        'stderr': truth.stderr,
        'stdout': truth_stdout,
        'error': str(e)
    }
    latest = out / 'latest_multiapp_chess_nowait.json'
    latest.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(1)

chess_status = truth_json.get('status', truth_json.get('truthStatus'))
chess_blocker = truth_json.get('blocker', truth_json.get('truthBlocker'))
chess_window_count = truth_json.get('windowCount')
if chess_window_count is None and truth_json.get('windowPresent') is False:
    chess_window_count = 0

result = {
    'ok': front != 'Safari' and len(running) >= 8 and 'Chess' in running and chess_status == 'no-window' and chess_blocker == 'chess-window-missing',
    'frontApp': front,
    'runningCount': len(running),
    'runningApps': running,
    'chessStatus': chess_status,
    'chessBlocker': chess_blocker,
    'chessWindowCount': chess_window_count,
    'truthCapturedAt': truth_json.get('capturedAt'),
    'truthSource': truth_stdout.splitlines()[-1] if truth_stdout else None
}
latest = out / 'latest_multiapp_chess_nowait.json'
latest.write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False))
sys.exit(0 if result['ok'] else 1)
