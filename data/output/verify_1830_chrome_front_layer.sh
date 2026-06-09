#!/bin/sh
set -eu

CARD="$1"

grep -F 'URL：`chrome://settings/content/javascript`' "$CARD" >/dev/null
grep -F '## 当前前台唯一真值' "$CARD" >/dev/null
grep -F '## 历史公开旁证' "$CARD" >/dev/null
grep -F '## 历史失败壳旁证' "$CARD" >/dev/null
grep -F '## 3条可证伪预测' "$CARD" >/dev/null

python3 - <<'PY'
import ssl
import urllib.request

checks = [
    ('https://channels.weixin.qq.com/platform/post/create', ['finder-helper-web', 'JavaScript']),
    ('https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/', ['weibo', 'login']),
    ('https://www.xiaohongshu.com/404?source=/publish/publish', ['页面不见了', '返回首页']),
]
ctx = ssl.create_default_context()
for url, markers in checks:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
        body = resp.read().decode('utf-8', errors='ignore').lower()
    for marker in markers:
        if marker.lower() not in body:
            raise SystemExit(f'missing marker {marker} for {url}')
print('ok')
PY
