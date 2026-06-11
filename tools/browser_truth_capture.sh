#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT_DIR/.taskline_artifacts/browser_observer}"
mkdir -p "$OUTDIR"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SAFE_TS="${TS//:/-}"
SUMMARY_FILE="$OUTDIR/browser_observation_${SAFE_TS}.json"

OBS_TMP=$(mktemp)
bash "$ROOT_DIR/tools/taskline_observe.sh" "$OUTDIR" > "$OBS_TMP"
python3 - "$SUMMARY_FILE" "$TS" "$OBS_TMP" <<'PY'
import json, pathlib, sys
summary_path = pathlib.Path(sys.argv[1])
ts = sys.argv[2]
obs_path = pathlib.Path(sys.argv[3])
raw = json.loads(obs_path.read_text())
running = raw.get("runningApps", [])
browsers = [app for app in running if app in {"Safari", "Google Chrome", "Chrome", "Microsoft Edge", "Arc", "Firefox", "Brave Browser"}]
out = {
  "capturedAt": ts,
  "observer": "browser_truth_capture",
  "frontApp": raw.get("frontApp", ""),
  "windowTitle": raw.get("windowTitle", ""),
  "runningApps": running,
  "browserAppsRunning": browsers,
  "frontIsBrowser": raw.get("frontApp", "") in {"Safari", "Google Chrome", "Chrome", "Microsoft Edge", "Arc", "Firefox", "Brave Browser"},
  "evidence": raw.get("evidence", {})
}
summary_path.write_text(json.dumps(out, ensure_ascii=False, indent=2))
print(json.dumps(out, ensure_ascii=False, indent=2))
obs_path.unlink(missing_ok=True)
PY
