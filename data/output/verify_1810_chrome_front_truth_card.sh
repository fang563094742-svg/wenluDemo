#!/bin/sh
set -eu
CARD='/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1810次呼吸-当前前台真值优先判断军法卡.md'
CHROME_URL=$(osascript -e 'tell application "Google Chrome" to if (count of windows) > 0 then get URL of active tab of front window')
FRONT_APP=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true')
[ "$FRONT_APP" = 'Google Chrome' ]
[ "$CHROME_URL" = 'chrome://settings/content/javascript' ]
grep -F 'Google Chrome `chrome://settings/content/javascript`' "$CARD" >/dev/null
grep -F '禁止把旧 Safari `http://127.0.0.1:3210/` 继续写成当前前台唯一真值。' "$CARD" >/dev/null
