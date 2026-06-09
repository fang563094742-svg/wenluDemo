#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1829次呼吸-Chrome当前前台与历史旁证3预测判断卡.md"
JSON="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/chrome_front_layer_prediction_card_1829.json"
[ -f "$CARD" ]
[ -f "$JSON" ]
grep -F 'Google Chrome' "$CARD" >/dev/null
grep -F 'chrome://settings/content/javascript' "$CARD" >/dev/null
grep -F '历史公开旁证' "$CARD" >/dev/null
grep -F '历史失败壳旁证' "$CARD" >/dev/null
python3 - <<'PY2'
import json, urllib.request, ssl
json_path = r"/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/chrome_front_layer_prediction_card_1829.json"
with open(json_path, 'r', encoding='utf-8') as f:
    data = json.load(f)
assert data['frontTruth']['url'] == 'chrome://settings/content/javascript'
ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
checks=[
 ('https://channels.weixin.qq.com/platform/post/create','channels.weixin.qq.com/platform/post/create','视频号助手'),
 ('https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/','passport.weibo.com/visitor/visitor','Sina Visitor System'),
 ('https://www.xiaohongshu.com/publish/publish','xiaohongshu.com/404?source=/publish/publish','页面不见了'),
]
for url, final_hint, body_hint in checks:
    with urllib.request.urlopen(url, timeout=15, context=ctx) as r:
        final = r.geturl()
        body = r.read(8000).decode('utf-8','ignore')
        assert final_hint in final, (url, final)
        assert body_hint in body, (url, body_hint)
print('ok')
PY2
