#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1866次呼吸-GitHub当前前台与外部存在性判断卡.md"
[ -f "$CARD" ]
grep -Fq "https://github.com/login/device/select_account" "$CARD"
grep -Fq "settings/access" "$CARD"
grep -Fq '外部直连都返回 `404`' "$CARD"
python3 - <<'PY2'
import urllib.request, urllib.error
checks = [
    ('https://github.com/fang563094742-svg/wenluDemo/settings/access', 404),
    ('https://github.com/fang563094742-svg/wenluDemo', 404),
]
for url, expected in checks:
    req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            code = r.getcode()
    except urllib.error.HTTPError as e:
        code = e.code
    if code != expected:
        raise SystemExit(1)
req = urllib.request.Request('https://github.com/login/device/select_account', headers={'User-Agent':'Mozilla/5.0'})
with urllib.request.urlopen(req, timeout=20) as r:
    final_url = r.geturl()
    code = r.getcode()
    body = r.read(1200).decode('utf-8', 'ignore')
if code != 200 or 'login' not in final_url or 'html-auth' not in body:
    raise SystemExit(1)
PY2
