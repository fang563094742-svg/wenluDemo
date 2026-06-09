#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
CARD="$ROOT/data/output/第1760次呼吸-可回证判断清单.md"
[ -f "$CARD" ]
python3 - <<'PY' "$CARD"
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
need = [
    '## 当前前台唯一真值',
    'http://127.0.0.1:3210/',
    '## 历史公开旁证',
    'https://channels.weixin.qq.com/platform/post/create',
    '## 历史失败壳旁证',
    'https://www.xiaohongshu.com/publish/publish',
    '## 3条可回证判断',
    '视频号助手',
    '你访问的页面不见了'
]
missing = [x for x in need if x not in text]
if missing:
    raise SystemExit('missing: ' + ', '.join(missing))
PY
front_url="$(osascript -e 'tell application "Safari" to return URL of front document')"
[ "$front_url" = "http://127.0.0.1:3210/" ]
python3 - <<'PY'
import urllib.request, urllib.parse
checks = [
    ('https://channels.weixin.qq.com/platform/post/create', '视频号助手'),
    ('https://www.xiaohongshu.com/publish/publish', '你访问的页面不见了')
]
for url, needle in checks:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode('utf-8', 'ignore')
        final_url = resp.geturl()
    if needle == '你访问的页面不见了':
        if needle not in body and '/404' not in final_url:
            raise SystemExit(f'xhs missing fail signal: {final_url}')
    else:
        if needle not in body:
            raise SystemExit(f'missing needle for {url}')
print('ok')
PY
