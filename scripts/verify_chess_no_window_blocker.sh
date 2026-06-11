#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
OUT="$(bash .wenlu_sensors/chess_truth_sensor.sh Chess)"
python3 - "$OUT" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
obj = json.loads(path.read_text())
assert obj.get('status') == 'no-window', obj
assert obj.get('blocker') in ('chess-window-missing', 'target-has-no-windows'), obj
assert obj.get('boardDetected') is False, obj
assert obj.get('windowCount') == 0, obj
assert obj.get('windowTitle', '') == '', obj
latest = path.parent / 'latest_chess_state.json'
if latest.exists():
    latest_obj = json.loads(latest.read_text())
    assert latest_obj.get('blocker') in ('chess-window-missing', 'target-has-no-windows'), latest_obj
print('verified chess no-window blocker via', path)
PY
