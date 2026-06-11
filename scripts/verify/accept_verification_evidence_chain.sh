#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

log=$(scripts/verify/verification_evidence_chain.sh | tail -n 1)
test -f "$log"
grep -F "test/unit/verificationEngine.test.ts" "$log" >/dev/null
grep -F '"verdict": "failed"' "$log" >/dev/null
grep -F 'ERROR: missing cmd for shell probe' "$log" >/dev/null
test -d artifacts/verification
test -f data/verifiable-task-chain/task-chain.json
test -f task_output/verifiable-task-chain/latest-verification.json
grep -F '"id": "vt-chain-bootstrap"' data/verifiable-task-chain/task-chain.json >/dev/null
grep -F '"passed": true' task_output/verifiable-task-chain/latest-verification.json >/dev/null

echo "verification evidence chain accepted via $log"