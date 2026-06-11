#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(npm run --silent polymarket:probe)"
printf '%s\n' "$out"
printf '%s' "$out" | python3 -c 'import json,sys; obj=json.load(sys.stdin); assert obj.get("ok") is True, obj; assert isinstance(obj.get("marketCount"), int) and obj["marketCount"] > 0, obj; assert isinstance(obj.get("sampleQuestion"), str) and len(obj["sampleQuestion"]) > 0, obj; print("polymarket probe verified")'
