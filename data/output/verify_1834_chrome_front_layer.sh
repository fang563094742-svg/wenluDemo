#!/bin/sh
set -eu

ROOT='/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo'
CARD="$ROOT/data/output/第1834次呼吸-Chrome当前前台与历史旁证3预测判断卡.md"

[ -f "$CARD" ]
grep -F '## 当前前台唯一真值' "$CARD" >/dev/null
grep -F 'chrome://settings/content/javascript' "$CARD" >/dev/null
grep -F '## 历史公开旁证' "$CARD" >/dev/null
grep -F '## 历史失败壳旁证' "$CARD" >/dev/null
grep -F '## 3条可证伪预测' "$CARD" >/dev/null
grep -F '## 这次比过去更可能命中的方法假设' "$CARD" >/dev/null

check_page() {
  url="$1"
  keyword="$2"
  expected_final="$3"
  tmp="$(mktemp)"
  python3 - "$url" "$tmp" <<'PY'
import sys, urllib.request
url, path = sys.argv[1], sys.argv[2]
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=20) as resp:
    final_url = resp.geturl()
    body = resp.read().decode('utf-8', 'ignore')
with open(path, 'w', encoding='utf-8') as fh:
    fh.write(final_url + "\n")
    fh.write(body)
PY
  grep -F "$expected_final" "$tmp" >/dev/null
  grep -F "$keyword" "$tmp" >/dev/null
  rm -f "$tmp"
}

check_page 'https://channels.weixin.qq.com/platform/post/create' 'finder-helper-web' 'https://channels.weixin.qq.com/platform/post/create'
check_page 'https://web.wechat.com/' 'WeChat/Weixin for Web' 'https://web.wechat.com/'
check_page 'https://www.xiaohongshu.com/publish/publish' '你访问的页面不见了' 'https://www.xiaohongshu.com/404?source=/publish/publish'
