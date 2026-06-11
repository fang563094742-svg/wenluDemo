#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INPUT_PATH="${1:-}"
OUTDIR="${2:-$ROOT_DIR/.taskline_artifacts/planner_chain}"
if [[ -z "$INPUT_PATH" ]]; then
  echo "usage: $(basename "$0") <candidates.json> [outdir]" >&2
  exit 1
fi
mkdir -p "$OUTDIR"
DECISION_PATH="$OUTDIR/taskline_decision.json"
OBS_PATH="$OUTDIR/taskline_observation.json"

npx tsx "$ROOT_DIR/tools/taskline_focus.ts" "$INPUT_PATH" "$DECISION_PATH" | tee "$OUTDIR/taskline_decision.stdout.json"
bash "$ROOT_DIR/tools/taskline_observe.sh" "$OUTDIR/observer" | tee "$OBS_PATH"

echo "decision=$DECISION_PATH"
echo "observation=$OBS_PATH"
