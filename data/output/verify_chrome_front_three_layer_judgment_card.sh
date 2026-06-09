#!/bin/sh
set -eu

CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/chrome_front_three_layer_judgment_card.md"

grep -F 'URL：`data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`' "$CARD" >/dev/null
grep -F '强旁证：`https://channels.weixin.qq.com/platform/post/create`' "$CARD" >/dev/null
grep -F '历史失败壳旁证' "$CARD" >/dev/null

python3 - <<'PY'
import urllib.request, sys
checks = [
    ('https://channels.weixin.qq.com/platform/post/create', ['finder-helper-web', 'JavaScript enabled']),
    ('https://web.okjike.com/publish', ['即刻', '聊AI，聊科技的人都在这里']),
    ('https://www.xiaohongshu.com/publish/publish', ['你访问的页面不见了', '自动返回首页']),
]
for url, words in checks:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        final_url = resp.geturl()
        body = resp.read().decode('utf-8', 'ignore')
    if url.endswith('/publish/publish') and '/404?source=/publish/publish' not in final_url:
        sys.exit(1)
    for word in words:
        if word not in body:
            sys.exit(1)
print('ok')
PY
