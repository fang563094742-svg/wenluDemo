#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUTDIR="${1:-$ROOT_DIR/artifacts/chess_verification}"
APP_NAME="${APP_NAME:-Chess}"
mkdir -p "$OUTDIR"

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SAFE_TS="${TS//:/-}"
SCREENSHOT="$OUTDIR/chess_front_${SAFE_TS}.png"
TRUTH_JSON="$OUTDIR/chess_truth_${SAFE_TS}.json"
OCR_TXT="$OUTDIR/chess_ocr_${SAFE_TS}.txt"
OCR_ERR="$OUTDIR/chess_ocr_${SAFE_TS}.err"
SUMMARY_JSON="$OUTDIR/chess_verification_${SAFE_TS}.json"
BOARD_JSON="$OUTDIR/chess_board_${SAFE_TS}.json"

osascript -e "tell application \"${APP_NAME}\" to activate" >/dev/null 2>&1 || true
sleep 0.2
"$ROOT_DIR/native_app_probe/native_app_truth_readonly.sh" > "$TRUTH_JSON"
/usr/sbin/screencapture -x "$SCREENSHOT"

BOARD_STATUS="unavailable"
if [ "$APP_NAME" = "Chess" ] && [ -f "$ROOT_DIR/native_app_probe/chess_board_probe.py" ]; then
  set +e
  python3 "$ROOT_DIR/native_app_probe/chess_board_probe.py" "$APP_NAME" > "$BOARD_JSON"
  BOARD_EXIT=$?
  set -e
  if [ "$BOARD_EXIT" -eq 0 ]; then
    BOARD_STATUS="ok"
  else
    BOARD_STATUS="failed"
  fi
else
  printf '{}\n' > "$BOARD_JSON"
fi

OCR_STATUS="unavailable"
OCR_EXIT=0
if [ -x "$ROOT_DIR/scripts/.build/wenlu-ocr" ]; then
  OCR_STATUS="ok"
  set +e
  "$ROOT_DIR/scripts/.build/wenlu-ocr" "$SCREENSHOT" > "$OCR_TXT" 2>"$OCR_ERR"
  OCR_EXIT=$?
  set -e
  if [ "$OCR_EXIT" -ne 0 ]; then
    OCR_STATUS="failed"
  fi
elif command -v ocrmac >/dev/null 2>&1; then
  OCR_STATUS="ok"
  set +e
  ocrmac "$SCREENSHOT" > "$OCR_TXT" 2>"$OCR_ERR"
  OCR_EXIT=$?
  set -e
  if [ "$OCR_EXIT" -ne 0 ]; then
    OCR_STATUS="failed"
  fi
else
  : > "$OCR_TXT"
  : > "$OCR_ERR"
fi

python3 - "$TRUTH_JSON" "$OCR_TXT" "$SCREENSHOT" "$SUMMARY_JSON" "$APP_NAME" "$TS" "$OCR_STATUS" "$OCR_EXIT" "$OCR_ERR" "$BOARD_JSON" "$BOARD_STATUS" <<'PY'
import json, pathlib, re, sys
truth_path = pathlib.Path(sys.argv[1])
ocr_path = pathlib.Path(sys.argv[2])
screenshot_path = pathlib.Path(sys.argv[3])
summary_path = pathlib.Path(sys.argv[4])
app_name = sys.argv[5]
ts = sys.argv[6]
ocr_status = sys.argv[7]
ocr_exit = int(sys.argv[8])
ocr_err_path = pathlib.Path(sys.argv[9])
board_path = pathlib.Path(sys.argv[10])
board_status = sys.argv[11]
truth = json.loads(truth_path.read_text())
ocr_text = ocr_path.read_text() if ocr_path.exists() else ""
ocr_err = ocr_err_path.read_text() if ocr_err_path.exists() else ""
try:
    board = json.loads(board_path.read_text()) if board_path.exists() else {}
except json.JSONDecodeError:
    board = {"ok": False, "blocker": "invalid-board-json"}
normalized = " ".join(ocr_text.split())
lines = [line.strip() for line in ocr_text.splitlines() if line.strip()]
patterns = {
    "files_header": bool(re.search(r"\ba\s+b\s+c\s+d\s+e\s+f\s+g\s+h\b", normalized, re.I)),
    "rank_8": any(re.search(r"^8\b", line) for line in lines),
    "rank_1": any(re.search(r"^1\b", line) for line in lines),
    "piece_symbols": bool(re.search(r"[RNBQKP]|[rnbqkp]", ocr_text)),
}
front_matches = truth.get("frontApp") == app_name
running_has_app = app_name in truth.get("runningApps", [])
window_title = truth.get("windowTitle", "")
window_has_game_signal = any(token in window_title for token in ["游戏", "Game", "白方走棋", "黑方走棋"])
ocr_has_board_signal = sum(1 for v in patterns.values() if v) >= 2
board_detected = bool(board.get("boardDetected"))
board_square_count = int(board.get("squareCount") or 0)
board_has_signal = board_detected or board_square_count >= 60
manual_review = []
failure_reasons = []
completion_reasons = []
if running_has_app:
    completion_reasons.append("app-running")
else:
    failure_reasons.append("app-not-running")
if front_matches:
    completion_reasons.append("app-frontmost")
else:
    manual_review.append("app-not-frontmost")
if window_has_game_signal:
    completion_reasons.append("window-title-supports-chess")
if board_status == "ok" and board_has_signal:
    completion_reasons.append("board-probe-detected-grid")
elif board_status == "failed":
    manual_review.append("board-probe-failed")
if ocr_status == "ok" and ocr_has_board_signal:
    completion_reasons.append("ocr-detected-board")
elif ocr_status == "failed":
    failure_reasons.append("ocr-failed")
elif ocr_status == "ok":
    manual_review.append("ocr-missing-board-signal")
if front_matches and ocr_status == "ok" and not ocr_has_board_signal and not board_has_signal:
    failure_reasons.append("frontmost-but-no-board-evidence")
completed = running_has_app and front_matches and (board_has_signal or ocr_has_board_signal or window_has_game_signal)
failed = bool(failure_reasons) and not completed
needs_review = not completed and not failed
verdict = "completed" if completed else "failed" if failed else "needs_review"
verification = {
    "capturedAt": ts,
    "appName": app_name,
    "frontApp": truth.get("frontApp", ""),
    "windowTitle": window_title,
    "runningApps": truth.get("runningApps", []),
    "frontMatches": front_matches,
    "runningHasApp": running_has_app,
    "windowHasGameSignal": window_has_game_signal,
    "boardProbe": {
        "status": board_status,
        "boardDetected": board_detected,
        "squareCount": board.get("squareCount"),
        "occupiedCount": board.get("occupiedCount"),
        "pieceCounts": board.get("pieceCounts", {}),
        "path": str(board_path),
        "raw": board,
    },
    "ocr": {
        "status": ocr_status,
        "exitCode": ocr_exit,
        "hasBoardSignal": ocr_has_board_signal,
        "patterns": patterns,
        "textPreview": lines[:12],
        "errorPreview": [line.strip() for line in ocr_err.splitlines() if line.strip()][:8],
        "path": str(ocr_path),
        "errorPath": str(ocr_err_path),
    },
    "artifacts": {
        "truthJson": str(truth_path),
        "screenshot": str(screenshot_path),
        "summary": str(summary_path),
    },
    "evidenceChain": {
        "completionReasons": completion_reasons,
        "failureReasons": failure_reasons,
        "manualReviewReasons": manual_review,
    },
    "successCriteria": {
        "completed": completed,
        "failure": failed,
        "needsReview": needs_review,
        "verdict": verdict,
    }
}
summary_path.write_text(json.dumps(verification, ensure_ascii=False, indent=2))
print(json.dumps(verification, ensure_ascii=False, indent=2))
PY

VERDICT=$(python3 - "$SUMMARY_JSON" <<'PY'
import json, pathlib, sys
summary = json.loads(pathlib.Path(sys.argv[1]).read_text())
print(summary["successCriteria"]["verdict"])
PY
)

echo "VERDICT=$VERDICT"
case "$VERDICT" in
  completed) exit 0 ;;
  needs_review) exit 2 ;;
  failed) exit 1 ;;
  *) exit 3 ;;
esac
