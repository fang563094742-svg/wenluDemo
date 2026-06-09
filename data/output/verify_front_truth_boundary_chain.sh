#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
front_app=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true')
test "$front_app" = "Safari"
front_url=$(osascript -e 'tell application "Safari" to if it is running then get URL of current tab of front window')
test "$front_url" = "http://127.0.0.1:3210/"
for u in https://web.wechat.com/ https://web.okjike.com/publish https://channels.weixin.qq.com/platform/post/create https://weibo.com/ https://www.xiaohongshu.com/publish/publish; do
  code=$(curl --noproxy "*" -L -s -o /dev/null -w "%{http_code}" "$u")
  test "$code" = "200"
done
latest_scan_dir=$(find artifacts -maxdepth 1 -type d -name 'public-demand-scan-*' | sort | tail -n 1)
test -n "$latest_scan_dir"
test -f "$latest_scan_dir/scan.json"
test -f data/capability-line/public-platform-truth-skeleton.json
grep -F '"url": "http://127.0.0.1:3210/"' data/capability-line/public-platform-truth-skeleton.json >/dev/null
grep -F '"dir": ' data/capability-line/public-platform-truth-skeleton.json >/dev/null
grep -F "$(basename "$latest_scan_dir")" task_output/front-truth-line/latest-front-truth-boundary-chain.md >/dev/null
grep -F 'front_app=Safari' task_output/front-truth-line/latest-front-truth-boundary-chain.md >/dev/null
grep -F 'front_url=http://127.0.0.1:3210/' task_output/front-truth-line/latest-front-truth-boundary-chain.md >/dev/null
echo passed
