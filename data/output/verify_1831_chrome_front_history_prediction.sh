#!/bin/sh
set -eu

CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1831次呼吸-Chrome当前前台与历史旁证3预测判断卡.md"

[ -f "$CARD" ]
grep -F 'URL：`chrome://settings/content/javascript`' "$CARD" >/dev/null
grep -F '历史公开旁证' "$CARD" >/dev/null
grep -F '历史失败壳旁证' "$CARD" >/dev/null
grep -F '3条具体、互斥、可验证的短期预测' "$CARD" >/dev/null

body_channels=$(curl --noproxy '*' -L --max-time 12 -A 'Mozilla/5.0' 'https://channels.weixin.qq.com/platform/post/create')
printf '%s' "$body_channels" | grep -F 'finder-helper-web' >/dev/null

body_weibo=$(curl --noproxy '*' -L --max-time 12 -A 'Mozilla/5.0' 'https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/')
printf '%s' "$body_weibo" | grep -F 'Sina Visitor System' >/dev/null

body_xhs=$(curl --noproxy '*' -L --max-time 12 -A 'Mozilla/5.0' 'https://www.xiaohongshu.com/publish/publish')
printf '%s' "$body_xhs" | grep -F '你访问的页面不见了' >/dev/null
