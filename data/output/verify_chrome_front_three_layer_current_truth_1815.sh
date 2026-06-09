#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/chrome_front_three_layer_current_truth_card_1815.md"
[ -f "$CARD" ]
grep -F 'chrome://settings/content/javascript' "$CARD" >/dev/null
grep -F '历史公开旁证' "$CARD" >/dev/null
grep -F '历史失败壳旁证' "$CARD" >/dev/null
BODY1=$(curl --noproxy '*' -L --max-time 15 -A 'Mozilla/5.0' -s 'https://web.okjike.com/publish')
printf '%s' "$BODY1" | python3 - <<'PY'
import sys
body = sys.stdin.read()
need = ['即刻']
raise SystemExit(0 if all(x in body for x in need) else 1)
PY
BODY2=$(curl --noproxy '*' -L --max-time 15 -A 'Mozilla/5.0' -s 'https://www.xiaohongshu.com/publish/publish')
printf '%s' "$BODY2" | python3 - <<'PY'
import sys
body = sys.stdin.read()
need = ['页面不见了']
raise SystemExit(0 if all(x in body for x in need) else 1)
PY
