#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
node_modules/.bin/tsx data/output/historyPublicEvidenceLayeredCard.ts >/dev/null
latest_scan="$(ls -dt artifacts/public-demand-scan-* | head -n 1)"
test -f task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md
test -f task_output/public-layered-frontdesk/latest-public-layered-frontdesk.json
grep -F "## 第一层：当前前台真值" task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md >/dev/null
grep -F "## 第二层：历史公开页正文级证据" task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md >/dev/null
grep -F "## 第三层：现行闭环边界" task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md >/dev/null
grep -F "https://sxsapi.com/post/860" task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md >/dev/null
grep -F "通过照片对比，识别冬虫夏草是人工的还是野生的" task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md >/dev/null
grep -F "frontTruth.url=http://127.0.0.1:3210/" task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md >/dev/null
grep -F "$(basename "$latest_scan")" task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md >/dev/null
node -e 'const fs=require("fs");const p="task_output/public-layered-frontdesk/latest-public-layered-frontdesk.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));if(!Array.isArray(j.evidence)||j.evidence.length<3)process.exit(1);if(!j.evidence.every(x=>x.title&&x.description&&x.deadline&&x.bodySnippet&&x.url.startsWith("https://sxsapi.com/post/")))process.exit(1);'
echo passed
