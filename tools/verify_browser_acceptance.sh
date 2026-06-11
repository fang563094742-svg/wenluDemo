#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_BROWSER="${1:-Safari}"
EXPECTATION="${2:-github-access-settings-front}"
MODE="${3:-observe}"
OUTDIR="${4:-$ROOT/verification_evidence/browser}"

if [ "$MODE" != "observe" ]; then
  echo "unsupported_mode=$MODE" >&2
  exit 2
fi

mkdir -p "$OUTDIR"
exec "$ROOT/scripts/verify_browser_frontdoor_chain.sh" "$OUTDIR" "$TARGET_BROWSER" "$EXPECTATION"
