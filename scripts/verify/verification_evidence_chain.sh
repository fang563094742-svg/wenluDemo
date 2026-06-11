#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p artifacts/verification
out="artifacts/verification/min_chain_$(date +%Y%m%d-%H%M%S).log"

{
  echo "[1/3] running unit verification engine test"
  npx vitest run test/unit/verificationEngine.test.ts
  echo
  echo "[2/3] running legacy empty verify deterministic failure check"
  npx tsx scripts/verify/legacy_empty_verify_check.ts
  echo
  echo "[3/3] materializing verifiable task chain artifact"
  npx tsx data/output/verifiableTaskChain.ts
} | tee "$out"

echo "$out"
