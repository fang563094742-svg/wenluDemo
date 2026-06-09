#!/bin/sh
set -eu
CARD="data/output/第1828次呼吸-Chrome当前前台与历史旁证最小判断卡.md"
[ -f "$CARD" ]
grep -Fq 'chrome://settings/content/javascript' "$CARD"
grep -Fq '## 当前前台唯一真值' "$CARD"
grep -Fq '## 历史公开旁证' "$CARD"
grep -Fq '## 历史失败壳旁证' "$CARD"
python3 - <<'PY'
import urllib.request
checks = [
    ('https://web.wechat.com/', 'WeChat/Weixin for Web'),
    ('https://web.okjike.com/publish', '即刻'),
    ('https://www.xiaohongshu.com/publish/publish', '页面不见了'),
]
for url, keyword in checks:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode('utf-8', 'ignore')
    if keyword not in body:
        raise SystemExit(f'missing keyword: {url} -> {keyword}')
print('ok')
PY
