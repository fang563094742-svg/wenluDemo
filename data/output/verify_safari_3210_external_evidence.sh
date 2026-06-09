#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
SCAN_JSON="$REPO_ROOT/artifacts/public-demand-scan-1780943346983/scan.json"
front_url="$(osascript -e 'tell application "System Events" to set frontApp to name of first application process whose frontmost is true' -e 'if frontApp is not "Safari" then error "frontApp=" & frontApp' -e 'tell application "Safari" to return (URL of current tab of front window)')"
[ "$front_url" = "http://127.0.0.1:3210/" ]
http_code="$(curl -L -s -o /tmp/safari_3210_external_body.html -w '%{http_code}' "$front_url")"
[ "$http_code" = "200" ]
rg -q '问路' /tmp/safari_3210_external_body.html
rg -q '"url": "https://sxsapi.com/post/860"' "$SCAN_JSON"
rg -q '通过照片对比，识别冬虫夏草是人工的还是野生的' "$SCAN_JSON"
echo 'verify_safari_3210_external_evidence: ok'
