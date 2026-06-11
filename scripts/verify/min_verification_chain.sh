#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
npx vitest run test/unit/verificationEngine.test.ts
