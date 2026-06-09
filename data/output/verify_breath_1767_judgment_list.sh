#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1767次呼吸-可回证判断清单.md"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

[ -f "$CARD" ]
grep -Fq 'Safari 当前前台唯一真值：`http://127.0.0.1:3210/`' "$CARD"
grep -Fq '历史公开旁证较强可操作壳：视频号助手 `https://channels.weixin.qq.com/platform/post/create`' "$CARD"
grep -Fq '历史公开旁证登录壳：微博 visitor `https://login.sina.com.cn/visitor/visitor`' "$CARD"
grep -Fq '历史失败壳旁证：小红书 publish `https://www.xiaohongshu.com/publish/publish`' "$CARD"
grep -Fq '## 3条短期可回证判断' "$CARD"

python3 - <<'PY' > "$TMPDIR/create.html"
import urllib.request
req = urllib.request.Request('https://channels.weixin.qq.com/platform/post/create', headers={'User-Agent':'Mozilla/5.0'})
print(urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore'))
PY
grep -Fq '视频号助手' "$TMPDIR/create.html"

VISITOR_FINAL="$(python3 - <<'PY'
import urllib.request
req = urllib.request.Request('https://login.sina.com.cn/visitor/visitor?a=crossdomain', headers={'User-Agent':'Mozilla/5.0'})
resp = urllib.request.urlopen(req, timeout=15)
print(resp.geturl())
PY
)"
printf '%s' "$VISITOR_FINAL" | grep -Fq 'login.sina.com.cn/visitor/visitor'

python3 - <<'PY' > "$TMPDIR/xhs.html"
import urllib.request
req = urllib.request.Request('https://www.xiaohongshu.com/publish/publish', headers={'User-Agent':'Mozilla/5.0'})
print(urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore'))
PY
grep -Fq '页面不见了' "$TMPDIR/xhs.html"
