#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
set +e
npx tsx scripts/verify/runVerificationChain.ts artifacts/verification-chain-negative.spec.json
code=$?
set -e
test "$code" -eq 1
latest=$(ls -t artifacts/verification_chains/verification-chain-negative/*.json | head -n 1)
grep -F '"verdict": "failed"' "$latest" >/dev/null
grep -F '缺失文件应触发失败' "$latest" >/dev/null
echo "$latest"
