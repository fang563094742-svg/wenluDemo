#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/chrome_front_truth_layered_current_1784.md"
[ -f "$CARD" ]
grep -F '## 当前前台唯一真值' "$CARD" >/dev/null
grep -F 'Google Chrome' "$CARD" >/dev/null
grep -F 'data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>' "$CARD" >/dev/null
grep -F '## 历史公开旁证' "$CARD" >/dev/null
grep -F 'https://channels.weixin.qq.com/platform/post/create' "$CARD" >/dev/null
grep -F '## 历史失败壳旁证' "$CARD" >/dev/null
grep -F 'https://www.xiaohongshu.com/publish/publish' "$CARD" >/dev/null
python3 - <<'PY'
import urllib.request
checks = [
    ('https://channels.weixin.qq.com/platform/post/create', 'finder-helper-web'),
    ('https://www.xiaohongshu.com/publish/publish', '你访问的页面不见了'),
]
for url, needle in checks:
    with urllib.request.urlopen(url, timeout=12) as resp:
        body = resp.read().decode('utf-8', 'ignore')
    if needle not in body:
        raise SystemExit(f'miss:{url}:{needle}')
print('ok')
PY
