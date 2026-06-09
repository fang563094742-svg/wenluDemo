#!/bin/sh
set -eu
ROOT="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo"
CARD="$ROOT/data/output/latest-safari-3210-strong-weak-fail-single-card.md"
[ -f "$CARD" ]
python3 - "$CARD" <<'PY2'
import sys, pathlib
text = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
needles = [
    'currentTruth.url=http://127.0.0.1:3210/',
    'strongEvidence.topLeadUrl=https://sxsapi.com/post/860',
    'weakEvidence.links=https://web.wechat.com/|https://web.okjike.com/publish|https://channels.weixin.qq.com/platform/post/create|https://weibo.com/|https://www.xiaohongshu.com/publish/publish',
    'failedEvidence.claim=把历史发布壳/登录壳直接说成当前正在操作的正文页',
]
missing = [n for n in needles if n not in text]
raise SystemExit(0 if not missing else 1)
PY2
front_app=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true')
front_url=$(osascript -e 'tell application "Safari" to if it is running then get URL of current tab of front window')
test "$front_app" = "Safari"
test "$front_url" = "http://127.0.0.1:3210/"
python3 - <<'PY3'
import urllib.request
checks = [
    ('https://sxsapi.com/post/860', '冬虫夏草'),
    ('https://channels.weixin.qq.com/platform/post/create', '视频号助手'),
    ('https://login.sina.com.cn/visitor/visitor?a=crossdomain&s=_2AkMdeSyxf8NxqwFRm_ARxG3nbotzzQjEieKrJd1qJRMxHRl-yT9yqk1StRB6NvkCXizMI_AX8TgVij9ooT9hjkOthq9g&sp=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5CdznTJU6UodG8yQaEv2Oy&from=weibo&_rand=0.614295351125&entry=miniblog&url=https%3A%2F%2Fweibo.com%2F', 'Sina Visitor System'),
    ('https://www.xiaohongshu.com/publish/publish', '你访问的页面不见了'),
]
for url, keyword in checks:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = r.read().decode('utf-8', 'ignore')
    if keyword not in body:
        raise SystemExit(1)
PY3
