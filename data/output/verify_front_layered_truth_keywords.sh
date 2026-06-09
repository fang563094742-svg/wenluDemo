#!/bin/sh
set -eu
ROOT="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo"
CARD="$ROOT/data/output/可检验判断卡-Safari3210-历史页分层.md"
python3 - <<'PY'
import ssl, urllib.request, sys, pathlib
root = pathlib.Path('/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo')
card = root / 'data/output/可检验判断卡-Safari3210-历史页分层.md'
text = card.read_text(encoding='utf-8')
required_local = [
    'frontTruth.url=http://127.0.0.1:3210/',
    'https://channels.weixin.qq.com/platform/post/create',
    'https://login.sina.com.cn/visitor/visitor',
    'https://www.xiaohongshu.com/publish/publish',
]
for item in required_local:
    if item not in text:
        raise SystemExit(1)
checks = [
    ('https://channels.weixin.qq.com/platform/post/create', ['视频号', '助手']),
    ('https://passport.weibo.com/visitor/visitor?entry=miniblog&a=enter&url=https%3A%2F%2Fweibo.com%2F&domain=weibo.com', ['Sina Visitor System', 'visitor']),
    ('https://www.xiaohongshu.com/publish/publish', ['你访问的页面不见了', '404']),
]
ctx = ssl.create_default_context()
for url, keywords in checks:
    with urllib.request.urlopen(url, timeout=20, context=ctx) as resp:
        body = resp.read().decode('utf-8', 'ignore')
    for kw in keywords:
        if kw not in body:
            raise SystemExit(1)
print('ok')
PY
