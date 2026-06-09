#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1823次呼吸-Chrome当前前台与历史旁证最小判断卡.md"
[ -f "$CARD" ]
grep -F 'chrome://settings/content/javascript' "$CARD" >/dev/null
grep -F '历史公开旁证' "$CARD" >/dev/null
grep -F '历史失败壳旁证' "$CARD" >/dev/null
python3 - <<'PY'
import urllib.request, sys
checks=[
 ('https://channels.weixin.qq.com/platform/post/create','视频号助手'),
 ('https://web.okjike.com/publish','即刻'),
 ('https://web.wechat.com/','WeChat/Weixin for Web'),
 ('https://www.xiaohongshu.com/publish/publish','页面不见了'),
]
for url, needle in checks:
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(req,timeout=15) as r:
        body=r.read().decode('utf-8','ignore')
        final=r.geturl()
    if needle not in body:
        print('missing-keyword', url, needle)
        sys.exit(1)
    if 'xiaohongshu.com/publish/publish' in url and '/404?source=/publish/publish' not in final:
        print('unexpected-final', final)
        sys.exit(1)
print('ok')
PY
