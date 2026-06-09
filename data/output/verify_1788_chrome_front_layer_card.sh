#!/bin/sh
set -eu

CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1788次呼吸-Chrome当前前台三层预测校准卡.md"
OUTDIR="/tmp/wenlu_1788_verify"
mkdir -p "$OUTDIR"

python3 - <<'PY' > "$OUTDIR/body_checks.txt"
import urllib.request

checks = [
    ("https://channels.weixin.qq.com/platform/post/create", "视频号助手"),
    ("https://login.sina.com.cn/visitor/visitor?a=crossdomain&s=_2AkMdeSyxf8NxqwFRm_ARxG3nbotzzQjEieKrJd1qJRMxHRl-yT9yqk1StRB6NvkCXizMI_AX8TgVij9ooT9hjkOthq9g&sp=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5CdznTJU6UodG8yQaEv2Oy&from=weibo&_rand=0.614295351125&entry=miniblog&url=https%3A%2F%2Fweibo.com%2F", "visitor"),
    ("https://www.xiaohongshu.com/publish/publish", "页面不见了"),
]
for url, needle in checks:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode("utf-8", errors="ignore")
    ok = needle in body
    print(f"{url}\t{needle}\t{'HIT' if ok else 'MISS'}")
    if not ok:
        raise SystemExit(1)
PY

grep -Fq '## 当前前台唯一真值' "$CARD"
grep -Fq 'Google Chrome' "$CARD"
grep -Fq 'data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>' "$CARD"
grep -Fq '## 历史公开旁证' "$CARD"
grep -Fq '## 历史失败壳旁证' "$CARD"
grep -Fq '## 预测命题' "$CARD"
grep -q 'HIT' "$OUTDIR/body_checks.txt"
grep -Fq 'https://channels.weixin.qq.com/platform/post/create' "$OUTDIR/body_checks.txt"
grep -Fq 'https://login.sina.com.cn/visitor/visitor' "$OUTDIR/body_checks.txt"
grep -Fq 'https://www.xiaohongshu.com/publish/publish' "$OUTDIR/body_checks.txt"
