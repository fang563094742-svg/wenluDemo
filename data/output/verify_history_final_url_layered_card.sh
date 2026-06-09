#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node_modules/.bin/tsx data/output/historyFinalUrlLayeredCard.ts >/dev/null
test -f task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md
test -f task_output/public-layered-frontdesk/latest-history-final-url-layered-card.json
grep -F "## 第一层：当前前台真值" task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null
grep -F "## 第二层：历史旁证的正文级证据" task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null
grep -F "## 第三层：闭环硬边界" task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null
grep -F "frontTruth.url=http://127.0.0.1:3210/" task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null
latest_scan="$(ls -dt artifacts/public-demand-scan-* | head -n 1)"
grep -F "$(basename "$latest_scan")" task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null
node -e 'const fs=require("fs");const p="task_output/public-layered-frontdesk/latest-history-final-url-layered-card.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));if(j.frontTruth.url!=="http://127.0.0.1:3210/")process.exit(1);if(!Array.isArray(j.evidence)||j.evidence.length<3)process.exit(1);if(!j.evidence.every(x=>x.url.startsWith("https://sxsapi.com/post/")&&x.title&&x.bodySnippet))process.exit(1);if(j.finalLead.url!==j.evidence[0].url)process.exit(1);'
echo passed
