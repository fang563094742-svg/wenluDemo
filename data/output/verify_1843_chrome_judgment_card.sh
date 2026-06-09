#!/bin/sh
set -eu

ROOT='/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo'
CARD="$ROOT/data/output/第1843次呼吸-当前Chrome前台与历史旁证判断校准卡.md"

[ -f "$CARD" ]
grep -F '## 明确结论' "$CARD" >/dev/null
grep -F 'chrome://settings/content/javascript' "$CARD" >/dev/null
grep -F 'platform/post/create' "$CARD" >/dev/null
grep -F '你访问的页面不见了' "$CARD" >/dev/null

check_page() {
  url="$1"
  keyword="$2"
  expected_final="$3"
  tmp="$(mktemp)"
  python3 - "$url" "$tmp" <<'PY'
import sys, urllib.request
url, path = sys.argv[1], sys.argv[2]
req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
with urllib.request.urlopen(req, timeout=20) as resp:
    final_url = resp.geturl()
    body = resp.read().decode('utf-8', 'ignore')
with open(path, 'w', encoding='utf-8') as fh:
    fh.write(final_url + '\n')
    fh.write(body)
PY
  grep -F "$expected_final" "$tmp" >/dev/null
  grep -F "$keyword" "$tmp" >/dev/null
  rm -f "$tmp"
}

check_page 'https://channels.weixin.qq.com/platform/post/create' 'finder-helper-web' 'https://channels.weixin.qq.com/platform/post/create'
check_page 'https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/' 'Sina Visitor System' 'https://passport.weibo.com/visitor/visitor'
check_page 'https://www.xiaohongshu.com/publish/publish' '你访问的页面不见了' 'https://www.xiaohongshu.com/404?source=/publish/publish'
