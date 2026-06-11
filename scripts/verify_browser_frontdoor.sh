#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/.taskline_artifacts/browser_front_truth_verify}"
mkdir -p "$OUT_DIR"
JSON_PATH="$(bash "$ROOT/.wenlu_sensors/browser_front_truth.sh" "$OUT_DIR" | tail -n 1)"
python3 - "$JSON_PATH" <<'PY'
import json, sys
path = sys.argv[1]
data = json.load(open(path))
if data.get('frontApp') != 'Safari':
    print(f"blocker=front-app-not-safari:{data.get('frontApp','')}")
    raise SystemExit(1)
url = data.get('safariFrontURL') or ''
if not url:
    print('blocker=safari-no-front-url')
    raise SystemExit(1)
if ('github.com' in url and '/settings/access' in url) or ('mail.google.com' in url):
    print('ok')
    raise SystemExit(0)
print(f"blocker=unsupported-safari-front-url:{url}")
raise SystemExit(1)
PY
