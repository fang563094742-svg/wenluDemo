#!/bin/sh
set -eu
CARD='data/output/第1761次呼吸-Safari3210-单对象3条可证伪最小预测卡.md'
[ -f "$CARD" ]
front_app=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true')
[ "$front_app" = 'Safari' ]
front_url=$(osascript -e 'tell application "Safari" to if it is running then get URL of current tab of front window')
[ "$front_url" = 'http://127.0.0.1:3210/' ]
front_title=$(osascript -e 'tell application "Safari" to if it is running then get name of current tab of front window')
[ "$front_title" = '问路' ]
for needle in \
  '预测对象：当前前台 Safari `http://127.0.0.1:3210/` 这一真值在后续判断中的使用口径。' \
  '1. **首句锁真值预测**' \
  '2. **旁证不越级预测**' \
  '3. **变更先结算预测**' \
  'falsifiableBy=' \
  'checkMethod=' \
  'truthBoundary=本轮当前前台正文真值只认 Safari 当前标签标题与 URL，不外推为任何公开平台正文。'
do
  grep -F "$needle" "$CARD" >/dev/null
done
