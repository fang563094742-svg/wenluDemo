#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1743次呼吸-当前前台三层预测卡.md"
python3 - <<'PY'
from pathlib import Path
import sys, urllib.request
card = Path('/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1743次呼吸-当前前台三层预测卡.md').read_text()
needles = [
    '## 当前前台唯一真值',
    'http://127.0.0.1:3210/',
    '## 历史公开旁证',
    '## 历史失败壳旁证',
    '## 待结算预测',
]
for needle in needles:
    if needle not in card:
        sys.exit(1)
checks = [
    ('https://channels.weixin.qq.com/platform/post/create','视频号助手'),
    ('https://login.sina.com.cn/visitor/visitor?a=crossdomain&s=_2AkMdeSyxf8NxqwFRm_ARxG3nbotzzQjEieKrJd1qJRMxHRl-yT9yqk1StRB6NvkCXizMI_AX8TgVij9ooT9hjkOthq9g&sp=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5CdznTJU6UodG8yQaEv2Oy&from=weibo&_rand=0.614295351125&entry=miniblog&url=https%3A%2F%2Fweibo.com%2F','Sina Visitor System'),
    ('https://www.xiaohongshu.com/publish/publish','你访问的页面不见了'),
]
for url, needle in checks:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    body = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
    if needle not in body:
        sys.exit(1)
print('ok')
PY
