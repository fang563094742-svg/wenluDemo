#!/bin/sh
set -eu
CARD='/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1770次呼吸-3条短期可回证判断清单.md'
[ -f "$CARD" ]
grep -F 'http://127.0.0.1:3210/' "$CARD" >/dev/null
grep -F '第一句先锁当前前台唯一真值' "$CARD" >/dev/null
grep -F '视频号 create 仍只算历史公开旁证中的较强可操作壳' "$CARD" >/dev/null
grep -F '小红书 publish/publish 仍只算历史失败壳旁证' "$CARD" >/dev/null
body_weibo=$(curl --noproxy '*' -L -s 'https://login.sina.com.cn/visitor/visitor?a=crossdomain&s=_2AkMdeSyxf8NxqwFRm_ARxG3nbotzzQjEieKrJd1qJRMxHRl-yT9yqk1StRB6NvkCXizMI_AX8TgVij9ooT9hjkOthq9g&sp=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5CdznTJU6UodG8yQaEv2Oy&from=weibo&_rand=0.614295351125&entry=miniblog&url=https%3A%2F%2Fweibo.com%2F' | python3 -c 'import sys; print(sys.stdin.read())')
body_xhs=$(curl --noproxy '*' -L -s 'https://www.xiaohongshu.com/publish/publish' | python3 -c 'import sys; print(sys.stdin.read())')
printf '%s' "$body_weibo" | python3 -c 'import sys; s=sys.stdin.read(); raise SystemExit(0 if ("visitor" in s or "weibo" in s or "login" in s) else 1)'
printf '%s' "$body_xhs" | python3 -c 'import sys; s=sys.stdin.read(); raise SystemExit(0 if ("404" in s or "页面" in s or "publish" in s) else 1)'
