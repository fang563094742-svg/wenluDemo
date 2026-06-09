#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1820次呼吸-Chrome当前前台与历史旁证三层判断卡.md"
[ -f "$CARD" ]
grep -F '当前前台唯一真值：Google Chrome `chrome://settings/content/javascript`' "$CARD" >/dev/null
grep -F '历史公开旁证（较强可操作壳）：视频号 `https://channels.weixin.qq.com/platform/post/create`' "$CARD" >/dev/null
grep -F '历史公开旁证（登录壳）：微博 visitor `https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/`' "$CARD" >/dev/null
grep -F '历史失败壳旁证：小红书 `https://www.xiaohongshu.com/publish/publish`' "$CARD" >/dev/null
CHANNELS_BODY=$(mktemp)
WEIBO_BODY=$(mktemp)
XHS_BODY=$(mktemp)
trap 'rm -f "$CHANNELS_BODY" "$WEIBO_BODY" "$XHS_BODY"' EXIT
curl --noproxy '*' -L -s 'https://channels.weixin.qq.com/platform/post/create' > "$CHANNELS_BODY"
curl --noproxy '*' -L -s 'https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/' > "$WEIBO_BODY"
curl --noproxy '*' -L -s 'https://www.xiaohongshu.com/publish/publish' > "$XHS_BODY"
grep -F '视频号助手' "$CHANNELS_BODY" >/dev/null
grep -F 'Sina Visitor System' "$WEIBO_BODY" >/dev/null
grep -F '你访问的页面不见了' "$XHS_BODY" >/dev/null
