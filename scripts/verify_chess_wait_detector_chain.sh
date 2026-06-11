#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="${1:-$ROOT/.taskline_artifacts/chess_wait_selftest}"
python3 "$ROOT/.taskline_artifacts/self_verify_chess_wait_detector.py" --outdir "$OUTDIR"
