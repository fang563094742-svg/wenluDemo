#!/bin/sh
set -eu
CARD="$1"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

[ -f "$CARD" ]

grep -F '## 当前前台唯一真值' "$CARD" >/dev/null
grep -F 'url=http://127.0.0.1:3210/' "$CARD" >/dev/null
grep -F '## 历史公开旁证' "$CARD" >/dev/null
grep -F '## 历史失败壳旁证' "$CARD" >/dev/null
grep -F 'https://channels.weixin.qq.com/platform/post/create' "$CARD" >/dev/null
grep -F 'https://login.sina.com.cn/visitor/visitor?...' "$CARD" >/dev/null
grep -F 'https://www.xiaohongshu.com/publish/publish' "$CARD" >/dev/null

python3 - <<'PY' "$TMPDIR"
import sys, urllib.request, ssl
from pathlib import Path

tmp = Path(sys.argv[1])
ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE
cases = [
    ("wechat_channels_create.html", "https://channels.weixin.qq.com/platform/post/create", "视频号助手"),
    ("sina_visitor.html", "https://login.sina.com.cn/visitor/visitor?a=crossdomain&s=_2AkMdeSyxf8NxqwFRm_ARxG3nbotzzQjEieKrJd1qJRMxHRl-yT9yqk1StRB6NvkCXizMI_AX8TgVij9ooT9hjkOthq9g&sp=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5CdznTJU6UodG8yQaEv2Oy&from=weibo&_rand=0.614295351125&entry=miniblog&url=https%3A%2F%2Fweibo.com%2F", "Sina Visitor System"),
    ("xiaohongshu_publish.html", "https://www.xiaohongshu.com/publish/publish", "你访问的页面不见了"),
]
for name, url, keyword in cases:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20, context=ssl_ctx) as resp:
        body = resp.read().decode("utf-8", errors="ignore")
    (tmp / name).write_text(body)
    if keyword not in body:
        raise SystemExit(f"keyword missing: {keyword} @ {url}")
PY
