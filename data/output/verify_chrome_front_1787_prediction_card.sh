#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1787次呼吸-Chrome前台三层预测校准卡.md"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
[ -f "$CARD" ]
grep -F '## 当前前台唯一真值' "$CARD" >/dev/null
grep -F 'URL：`data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`' "$CARD" >/dev/null
grep -F '## 历史公开旁证' "$CARD" >/dev/null
grep -F 'https://channels.weixin.qq.com/platform/post/create' "$CARD" >/dev/null
grep -F 'https://login.sina.com.cn/visitor/visitor' "$CARD" >/dev/null
grep -F '## 历史失败壳旁证' "$CARD" >/dev/null
grep -F 'https://www.xiaohongshu.com/publish/publish' "$CARD" >/dev/null
grep -F '## 明确预测命题' "$CARD" >/dev/null
python3 -c 'import urllib.request,sys;sys.stdout.write(urllib.request.urlopen("https://web.wechat.com/", timeout=12).read().decode("utf-8","ignore"))' > "$TMPDIR/wechat.html"
python3 -c 'import urllib.request,sys;sys.stdout.write(urllib.request.urlopen("https://www.xiaohongshu.com/404?source=/publish/publish", timeout=12).read().decode("utf-8","ignore"))' > "$TMPDIR/xhs404.html"
grep -F 'WeChat/Weixin for Web' "$TMPDIR/wechat.html" >/dev/null
grep -F '你访问的页面不见了' "$TMPDIR/xhs404.html" >/dev/null
