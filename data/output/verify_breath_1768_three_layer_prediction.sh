#!/bin/sh
set -eu
CARD='/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1768次呼吸-三层分界预测卡.md'
[ -f "$CARD" ]
grep -F 'url=http://127.0.0.1:3210/' "$CARD" >/dev/null
grep -F 'stronger=视频号 `https://channels.weixin.qq.com/platform/post/create` 属于较强可操作壳旁证。' "$CARD" >/dev/null
grep -F 'weaker=微博 `https://login.sina.com.cn/visitor/visitor?...` 属于登录壳旁证。' "$CARD" >/dev/null
grep -F 'failed=xiaohongshu `https://www.xiaohongshu.com/publish/publish`' "$CARD" >/dev/null
python3 - <<'PY'
import urllib.request
strong = urllib.request.urlopen('https://channels.weixin.qq.com/platform/post/create', timeout=12).read().decode('utf-8','ignore')
weak = urllib.request.urlopen('https://login.sina.com.cn/visitor/visitor?a=crossdomain&s=_2AkMdeSyxf8NxqwFRm_ARxG3nbotzzQjEieKrJd1qJRMxHRl-yT9yqk1StRB6NvkCXizMI_AX8TgVij9ooT9hjkOthq9g&sp=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5CdznTJU6UodG8yQaEv2Oy&from=weibo&_rand=0.614295351125&entry=miniblog&url=https%3A%2F%2Fweibo.com%2F', timeout=12).read().decode('utf-8','ignore')
fail = urllib.request.urlopen('https://www.xiaohongshu.com/publish/publish', timeout=12).read().decode('utf-8','ignore')
assert '视频号助手' in strong
assert ('visitor' in weak.lower()) or ('weibo' in weak.lower())
assert ('页面不见了' in fail) or ('404' in fail)
PY
