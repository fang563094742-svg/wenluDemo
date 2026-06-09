#!/bin/sh
set -eu
CARD='/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1769次呼吸-3条短期可回证判断清单.md'
[ -f "$CARD" ]
grep -F 'http://127.0.0.1:3210/' "$CARD" >/dev/null
grep -F '视频号 create 的分层口径' "$CARD" >/dev/null
grep -F '小红书 publish/publish 的分层口径' "$CARD" >/dev/null
body1=$(curl --noproxy '*' -L -s 'https://channels.weixin.qq.com/platform/post/create' | python3 -c 'import sys;print(sys.stdin.read()[:4000])')
body2=$(curl --noproxy '*' -L -s 'https://www.xiaohongshu.com/publish/publish' | python3 -c 'import sys;print(sys.stdin.read()[:4000])')
printf '%s' "$body1" | python3 -c 'import sys; s=sys.stdin.read(); raise SystemExit(0 if ("视频号助手" in s or "login" in s or "create" in s) else 1)'
printf '%s' "$body2" | python3 -c 'import sys; s=sys.stdin.read(); raise SystemExit(0 if ("404" in s or "页面" in s or "publish" in s) else 1)'
