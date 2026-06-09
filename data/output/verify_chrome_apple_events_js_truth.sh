#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1777次呼吸-Chrome-Apple-Events-JS-真值卡.md"
PREF="/Users/a333/Library/Application Support/Google/Chrome/Default/Preferences"
[ -f "$CARD" ]
[ -f "$PREF" ]
grep -F '当前前台唯一真值: Safari `http://127.0.0.1:3210/`' "$CARD" >/dev/null
grep -F 'browser.allow_javascript_apple_events = true' "$CARD" >/dev/null
python3 - <<'PY'
import json
p='/Users/a333/Library/Application Support/Google/Chrome/Default/Preferences'
with open(p,'r',encoding='utf-8') as f:
    data=json.load(f)
raise SystemExit(0 if data.get('browser',{}).get('allow_javascript_apple_events') is True else 1)
PY
osascript -e 'tell application "Google Chrome" to get JavaScript from front document' >/tmp/chrome_js_probe.out 2>/tmp/chrome_js_probe.err || true
grep -F -- '-1708' /tmp/chrome_js_probe.err >/dev/null
