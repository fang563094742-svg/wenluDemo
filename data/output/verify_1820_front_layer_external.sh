#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1820次呼吸-Chrome当前前台三层判断卡.md"
python3 - <<'PY'
from pathlib import Path
import ssl, urllib.request
card = Path('/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1820次呼吸-Chrome当前前台三层判断卡.md').read_text(encoding='utf-8')
for needle in [
    '当前前台唯一真值',
    'Google Chrome `chrome://settings/content/javascript`',
    '历史公开旁证',
    '历史失败壳旁证'
]:
    if needle not in card:
        raise SystemExit(1)
checks = [
    ('https://channels.weixin.qq.com/platform/post/create', 'platform/post/create', 'DOCTYPE html'),
    ('https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/', 'passport.weibo.com/visitor/visitor', 'Sina Visitor System'),
    ('https://www.xiaohongshu.com/publish/publish', '/404?source=/publish/publish', '<!doctype html>'),
]
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
for url, final_need, body_need in checks:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
        final_url = resp.geturl()
        body = resp.read().decode('utf-8', 'ignore')
    if final_need not in final_url:
        raise SystemExit(1)
    if body_need not in body:
        raise SystemExit(1)
print('ok')
PY
