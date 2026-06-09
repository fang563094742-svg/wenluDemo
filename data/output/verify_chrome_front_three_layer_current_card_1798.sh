#!/bin/sh
set -eu

CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/chrome_front_three_layer_current_card_1798.md"
[ -f "$CARD" ]

grep -Fq 'URL：`data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`' "$CARD"
grep -Fq '历史公开旁证（较强可操作壳）：`https://channels.weixin.qq.com/platform/post/create`' "$CARD"
grep -Fq '历史公开旁证（登录壳）：`https://login.sina.com.cn/visitor/visitor' "$CARD"
grep -Fq '历史失败壳旁证：`https://www.xiaohongshu.com/publish/publish`' "$CARD"
grep -Fq '待结算预测' "$CARD"

python3 - <<'PY'
import urllib.request

def body(url):
    req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode('utf-8','ignore')

wx = body('https://channels.weixin.qq.com/platform/post/create')
jike = body('https://web.okjike.com/publish')
xhs = body('https://www.xiaohongshu.com/publish/publish')
assert "finder-helper-web" in wx
assert "即刻" in jike
assert "你访问的页面不见了" in xhs
print('PASS')
PY
