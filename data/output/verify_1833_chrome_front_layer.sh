#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1833次呼吸-Chrome当前前台与历史旁证3预测判断卡.md"
[ -f "$CARD" ]
grep -Fq 'URL：`chrome://settings/content/javascript`' "$CARD"
grep -Fq 'historical-strong-shell' "$CARD"
grep -Fq 'historical-failure-shell' "$CARD"
python3 - <<'PY'
import urllib.request
checks = [
    ('https://channels.weixin.qq.com/platform/post/create', 'finder-helper-web'),
    ('https://web.wechat.com/', 'WeChat/Weixin for Web'),
    ('https://web.okjike.com/publish', '即刻'),
    ('https://www.xiaohongshu.com/publish/publish', '你访问的页面不见了'),
]
for url, needle in checks:
    with urllib.request.urlopen(url, timeout=15) as r:
        body = r.read(500000).decode('utf-8', 'ignore')
    if needle not in body:
        raise SystemExit(f'miss:{url}:{needle}')
print('ok')
PY
