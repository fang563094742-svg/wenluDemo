#!/bin/sh
set -eu
ROOT='/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo'
CARD="$ROOT/data/output/第1774次呼吸-单对象3条可证伪预测卡.md"
EXT="$ROOT/data/output/safari_3210_external_evidence_card.md"
[ -f "$CARD" ]
grep -F '当前前台唯一真值是 Safari `http://127.0.0.1:3210/`' "$CARD" >/dev/null
grep -F '历史公开旁证：视频号 create、微博 visitor、即刻 publish、WeChat web。' "$CARD" >/dev/null
grep -F '历史失败壳旁证：小红书 publish/publish、小红书 404。' "$CARD" >/dev/null
grep -F '最终 URL：`http://127.0.0.1:3210/`' "$EXT" >/dev/null
python3 - <<'PY2'
import urllib.request, sys
checks = [
    ('https://channels.weixin.qq.com/platform/post/create', ['视频号助手', 'create', 'login']),
    ('https://www.xiaohongshu.com/publish/publish', ['404', '页面', 'publish']),
]
for url, needles in checks:
    body = urllib.request.urlopen(url, timeout=12).read().decode('utf-8', 'ignore')
    if not any(n in body for n in needles):
        raise SystemExit(1)
raise SystemExit(0)
PY2
