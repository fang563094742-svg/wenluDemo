#!/bin/sh
set -eu
python3 - <<'PY'
from pathlib import Path
import urllib.request
card = Path('/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1844次呼吸-判断校准卡.md').read_text(encoding='utf-8')
needles = [
    'chrome://settings/content/javascript',
    '历史公开旁证',
    '历史失败壳旁证',
    'Sina Visitor System',
    'formula-runtime',
]
for needle in needles:
    if needle not in card:
        raise SystemExit(1)
checks = [
    ('https://web.wechat.com/', 'WeChat/Weixin for Web', None),
    ('https://web.okjike.com/publish', '即刻', None),
    ('https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/', 'Sina Visitor System', 'passport.weibo.com/visitor/visitor'),
    ('https://www.xiaohongshu.com/publish/publish', 'formula-runtime', '/404?source=/publish/publish'),
]
for url, keyword, final_part in checks:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as response:
        body = response.read().decode('utf-8', 'ignore')
        final_url = response.geturl()
    if keyword not in body:
        raise SystemExit(1)
    if final_part and final_part not in final_url:
        raise SystemExit(1)
print('ok')
PY
