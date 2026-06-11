#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npx tsx scripts/verify/runVerificationChain.ts artifacts/verification-chain-bootstrap.spec.json
