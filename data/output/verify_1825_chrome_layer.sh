#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1825次呼吸-Chrome当前前台与历史旁证判断清单.md"
grep -Fq 'URL：`chrome://settings/content/javascript`' "$CARD"
grep -Fq 'https://channels.weixin.qq.com/platform/post/create' "$CARD"
grep -Fq 'https://www.xiaohongshu.com/publish/publish' "$CARD"
python3 - <<'PY'
import urllib.request
checks = [
  ('https://channels.weixin.qq.com/platform/post/create', ['finder-helper-web','视频号助手']),
  ('https://www.xiaohongshu.com/publish/publish', ['404','你访问的页面不见了']),
]
for url, tokens in checks:
    req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = r.read().decode('utf-8', 'ignore')
        if not all(token in body for token in tokens):
            raise SystemExit(1)
print('ok')
PY
