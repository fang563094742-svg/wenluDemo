#!/bin/sh
set -eu
CARD='/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1868次呼吸-GitHub当前前台与外部直连最小分界卡.md'
URL='https://github.com/fang563094742-svg/wenluDemo/settings/access'
TMP='/tmp/wenlu_gh_access_verify.html'
code="$(curl --noproxy '*' -L -s -o "$TMP" -w '%{http_code}' "$URL")"
[ "$code" = '404' ]
grep -Fq '当前前台唯一真值：Google Chrome 当前标签是 `https://github.com/settings/tokens`' "$CARD"
grep -Fq '外部直连真值：`curl --noproxy '\''*'\'' -L -I https://github.com/fang563094742-svg/wenluDemo/settings/access` 当场返回 `404`。' "$CARD"
grep -Fq '单条可检验预测：如果用户回来继续追问 GitHub 同主题，我第一句会先锁' "$CARD"
