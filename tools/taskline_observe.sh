#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT_DIR/.taskline_artifacts/observer}"
mkdir -p "$OUTDIR"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SAFE_TS="${TS//:/-}"
RAW_JSON="$OUTDIR/native_app_truth_${SAFE_TS}.json"
PNG_FILE="$OUTDIR/native_app_front_${SAFE_TS}.png"
OCR_FILE="$OUTDIR/native_app_ocr_${SAFE_TS}.txt"
SUMMARY_FILE="$OUTDIR/taskline_observation_${SAFE_TS}.json"

bash "$ROOT_DIR/native_app_probe/native_app_truth_readonly.sh" > "$RAW_JSON"
if command -v screencapture >/dev/null 2>&1; then
  screencapture -x "$PNG_FILE" || true
fi
OCR_STATUS="unavailable"
OCR_PREVIEW=""
if command -v ocrmac >/dev/null 2>&1 || command -v tesseract >/dev/null 2>&1; then
  bash "$ROOT_DIR/tools/screen_ocr.sh" "$PNG_FILE" > "$OCR_FILE" || true
  OCR_STATUS="captured"
  OCR_PREVIEW=$(python3 - "$OCR_FILE" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text(errors='ignore') if p.exists() else ''
text = ' '.join(text.split())
print(text[:400])
PY
)
else
  printf 'OCR_UNAVAILABLE\n' > "$OCR_FILE"
fi

python3 - "$RAW_JSON" "$SUMMARY_FILE" "$TS" "$PNG_FILE" "$OCR_FILE" "$OCR_STATUS" "$OCR_PREVIEW" <<'PY'
import json, pathlib, sys
raw_path = pathlib.Path(sys.argv[1])
out_path = pathlib.Path(sys.argv[2])
ts, png, ocr_file, ocr_status, ocr_preview = sys.argv[3:8]
raw = json.loads(raw_path.read_text())
summary = {
  "capturedAt": ts,
  "frontApp": raw.get("frontApp", ""),
  "windowTitle": raw.get("windowTitle", ""),
  "runningApps": raw.get("runningApps", []),
  "evidence": {
    "rawJson": str(raw_path),
    "screenshot": str(pathlib.Path(png)) if pathlib.Path(png).exists() else None,
    "ocrText": str(pathlib.Path(ocr_file)),
    "ocrStatus": ocr_status,
    "ocrPreview": ocr_preview,
  }
}
out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps(summary, ensure_ascii=False, indent=2))
PY
