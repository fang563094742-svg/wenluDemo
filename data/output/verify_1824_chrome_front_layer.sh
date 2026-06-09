#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1824次呼吸-Chrome当前前台与历史旁证分层卡.md"
[ -f "$CARD" ]
grep -Fq 'URL：`chrome://settings/content/javascript`' "$CARD"
grep -Fq '历史公开旁证' "$CARD"
grep -Fq '历史失败壳旁证' "$CARD"
python3 - <<'PY'
import urllib.request
checks = [
    ('https://channels.weixin.qq.com/platform/post/create', 'finder-helper-web'),
    ('https://www.xiaohongshu.com/publish/publish', '你访问的页面不见了'),
]
for url, needle in checks:
    body = urllib.request.urlopen(url, timeout=12).read().decode('utf-8', 'ignore')
    if needle not in body:
        raise SystemExit(1)
print('ok')
PY
