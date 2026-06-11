#!/usr/bin/env bash
set -euo pipefail
if [ $# -ne 1 ]; then
  echo "usage: $0 <spec.json>" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
npx tsx scripts/verify/runVerificationChain.ts "$1"
