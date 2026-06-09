#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/chrome_front_three_layer_recheck_card.md"
mkdir -p "$(dirname "$CARD")"
cat > "$CARD" <<'EOF'
# Chrome当前前台与历史旁证三层复核卡

生成时间：2026-06-09 09:00 CST

## 当前前台唯一真值
- app=`Google Chrome`
- title=`codex-chrome-js-ok`
- url=`data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`
- 结论：当前前台只认本地 `data:` 页，不认任何历史公开页。

## 历史公开旁证
- 强旁证：`https://channels.weixin.qq.com/platform/post/create`
  - 最终URL应仍包含 `platform/post/create`
  - 正文应命中 `finder-helper-web`
- 中旁证：`https://web.okjike.com/publish`
  - 最终URL应仍包含 `web.okjike.com/publish`
  - 正文应命中 `即刻`
- 登录壳旁证：`https://login.sina.com.cn/visitor/visitor`
  - 最终URL应仍包含 `visitor/visitor`

## 历史失败壳旁证
- `https://www.xiaohongshu.com/publish/publish`
  - 最终URL应落到 `404`
  - 正文应命中 `你访问的页面不见了`

## 单条判断
- 当前前台唯一真值是 Chrome `data:` 页。
- 视频号 create 只属历史强旁证，不是当前页。
- 小红书 publish/publish 只属历史失败壳旁证，不是可用发布页。
EOF
python3 - <<'PY'
import urllib.request, urllib.error
checks = [
    ("https://channels.weixin.qq.com/platform/post/create", "platform/post/create", "finder-helper-web"),
    ("https://web.okjike.com/publish", "web.okjike.com/publish", "即刻"),
    ("https://www.xiaohongshu.com/publish/publish", "xiaohongshu.com/404", "你访问的页面不见了"),
]
for url, final_need, body_need in checks:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        final_url = resp.geturl()
        body = resp.read().decode('utf-8', 'ignore')
    if final_need not in final_url:
        raise SystemExit(f"final url mismatch: {url} -> {final_url}")
    if body_need not in body:
        raise SystemExit(f"body keyword missing: {url} -> {body_need}")
PY
grep -Fq 'url=`data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`' "$CARD"
grep -Fq 'finder-helper-web' "$CARD"
grep -Fq '你访问的页面不见了' "$CARD"
echo OK
