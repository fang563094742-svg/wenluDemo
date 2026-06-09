#!/bin/sh
set -eu
CARD="data/output/safari-3210-history-layered-evidence-card.md"
[ -f "$CARD" ]
grep -F 'url: http://127.0.0.1:3210/' "$CARD" >/dev/null
grep -F 'layer: 历史公开旁证-较强可操作壳' "$CARD" >/dev/null
grep -F 'layer: 历史失败壳旁证' "$CARD" >/dev/null
python3 - <<'PY'
import urllib.request
checks = [
    ('https://channels.weixin.qq.com/platform/post/create', '视频号助手'),
    ('https://login.sina.com.cn/visitor/visitor?a=crossdomain&s=_2AkMdeSyxf8NxqwFRm_ARxG3nbotzzQjEieKrJd1qJRMxHRl-yT9yqk1StRB6NvkCXizMI_AX8TgVij9ooT9hjkOthq9g&sp=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5CdznTJU6UodG8yQaEv2Oy&from=weibo&_rand=0.614295351125&entry=miniblog&url=https%3A%2F%2Fweibo.com%2F', 'visitor'),
    ('https://www.xiaohongshu.com/publish/publish', '/404?source=/publish/publish')
]
for url, needle in checks:
    req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15) as r:
        body = r.read().decode('utf-8','ignore')
        final = r.geturl()
        if needle.startswith('/'):
            if needle not in final:
                raise SystemExit(1)
        else:
            if needle not in body:
                raise SystemExit(1)
print('ok')
PY
