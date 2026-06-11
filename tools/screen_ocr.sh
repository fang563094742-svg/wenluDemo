#!/bin/sh
set -eu
if [ "$#" -ge 1 ] && [ -n "${1:-}" ]; then
  IMAGE="$1"
else
  IMAGE="/tmp/wenlu_screen_ocr.png"
  /usr/sbin/screencapture -x "$IMAGE"
fi
if command -v ocrmac >/dev/null 2>&1; then
  ocrmac "$IMAGE"
elif command -v tesseract >/dev/null 2>&1; then
  tesseract "$IMAGE" stdout 2>/dev/null
else
  echo "OCR_UNAVAILABLE"
  exit 0
fi
