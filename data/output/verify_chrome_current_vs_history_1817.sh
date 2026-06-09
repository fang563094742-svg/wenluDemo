#!/bin/sh
set -eu
CARD="$1"
[ -f "$CARD" ]
grep -F 'chrome://settings/content/javascript' "$CARD" >/dev/null
grep -F '## 历史公开旁证' "$CARD" >/dev/null
grep -F '## 历史失败壳旁证' "$CARD" >/dev/null
body1=$(curl --noproxy '*' -L --max-time 15 -s 'https://channels.weixin.qq.com/platform/post/create')
printf '%s' "$body1" | python3 -c "import sys; data=sys.stdin.read(); sys.exit(0 if 'finder-helper-web' in data or 'JavaScript enabled' in data else 1)"
body2=$(curl --noproxy '*' -L --max-time 15 -s 'https://www.xiaohongshu.com/publish/publish')
printf '%s' "$body2" | python3 -c "import sys; data=sys.stdin.read(); sys.exit(0 if '你访问的页面不见了' in data or '自动返回首页' in data else 1)"
