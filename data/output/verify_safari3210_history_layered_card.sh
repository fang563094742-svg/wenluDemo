#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/可检验判断卡-Safari3210-历史页分层.md"
python3 - "$CARD" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
text = p.read_text(encoding='utf-8')
needles = [
    '## 第一层：当前前台真值',
    'http://127.0.0.1:3210/',
    '## 第二层：历史页与公开入口层',
    'https://web.wechat.com/',
    'https://web.okjike.com/publish',
    'https://channels.weixin.qq.com/platform/post/create',
    'https://www.xiaohongshu.com/publish/publish',
    '## 第三层：分界硬规则',
]
missing = [n for n in needles if n not in text]
raise SystemExit(0 if not missing else 1)
PY
python3 - <<'PY'
import urllib.request
checks = [
    ('https://web.wechat.com/', 'WeChat'),
    ('https://web.okjike.com/publish', '即刻'),
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
PY
