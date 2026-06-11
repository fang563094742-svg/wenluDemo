#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUTDIR="${1:-$ROOT_DIR/artifacts/chess_verification}"
if bash "$ROOT_DIR/scripts/verify/chess_verification_evidence_chain.sh" "$OUTDIR"; then
  exit 0
fi
status=$?
if [ "$status" -eq 2 ]; then
  echo "Chess verification produced evidence but requires manual review: app is running yet not frontmost."
fi
exit "$status"
