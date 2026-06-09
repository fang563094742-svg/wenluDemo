#!/bin/bash
set -euo pipefail
URL=$(osascript -e 'tell application "System Events" to set frontApp to name of first application process whose frontmost is true' -e 'if frontApp is not "Safari" then error "frontApp=" & frontApp' -e 'tell application "Safari" to return (URL of current tab of front window)')
TITLE=$(osascript -e 'tell application "Safari" to return (name of current tab of front window)')
CODE=$(curl -L -s -o /tmp/safari_front_snapshot_body.html -w '%{http_code}' "$URL")
KEYWORD=$(python3 - <<'PY'
from pathlib import Path
body = Path('/tmp/safari_front_snapshot_body.html').read_text(errors='ignore')
for keyword in ['问路', 'WeChat', '视频号助手', 'Sina Visitor System', '你访问的页面不见了']:
    if keyword in body:
        print(keyword)
        break
else:
    print('')
PY
)
printf 'frontApp=Safari\nurl=%s\ntitle=%s\nhttp=%s\nkeyword=%s\n' "$URL" "$TITLE" "$CODE" "$KEYWORD"
