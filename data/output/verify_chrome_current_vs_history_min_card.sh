#!/bin/sh
set -eu

CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/chrome_current_vs_history_min_judgment_card.md"

front_app="$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true')"
[ "$front_app" = "Google Chrome" ]

front_title="$(osascript -e 'tell application "Google Chrome" to get title of active tab of front window')"
front_url="$(osascript -e 'tell application "Google Chrome" to get URL of active tab of front window')"
[ "$front_title" = "设置 - JavaScript" ]
[ "$front_url" = "chrome://settings/content/javascript" ]

grep -Fq '## 当前Chrome前台唯一真值' "$CARD"
grep -Fq 'chrome://settings/content/javascript' "$CARD"
grep -Fq '## 历史公开旁证' "$CARD"
grep -Fq 'https://channels.weixin.qq.com/platform/post/create' "$CARD"
grep -Fq 'https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/' "$CARD"
grep -Fq '## 历史失败壳旁证' "$CARD"
grep -Fq 'https://www.xiaohongshu.com/publish/publish' "$CARD"
grep -Fq '## 3条可证伪预测' "$CARD"

python3 - <<'PY'
import urllib.request

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        final_url = r.geturl()
        body = r.read().decode('utf-8', 'ignore')
    return final_url, body

wx_final, wx_body = fetch('https://channels.weixin.qq.com/platform/post/create')
assert 'channels.weixin.qq.com/platform/post/create' in wx_final
assert 'finder-helper-web' in wx_body
assert 'JavaScript enabled' in wx_body

jike_final, jike_body = fetch('https://web.okjike.com/publish')
assert 'web.okjike.com/publish' in jike_final
assert '即刻' in jike_body

xhs_final, xhs_body = fetch('https://www.xiaohongshu.com/publish/publish')
assert 'xiaohongshu.com' in xhs_final
assert '你访问的页面不见了' in xhs_body
assert '3 秒后将自动返回首页' in xhs_body
PY

echo PASS
