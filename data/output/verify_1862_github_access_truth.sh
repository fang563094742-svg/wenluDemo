#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1862次呼吸-GitHub当前前台页与外部404分界卡.md"
[ -f "$CARD" ]
grep -Fq 'https://github.com/fang563094742-svg/wenluDemo/settings/access?guidance_task=' "$CARD"
grep -Fq 'wenluDemoWeb' "$CARD"
grep -Fq 'HTTP `404`' "$CARD"
TMP_HEAD="$(mktemp)"
TMP_BODY="$(mktemp)"
cleanup(){ rm -f "$TMP_HEAD" "$TMP_BODY"; }
trap cleanup EXIT
curl --noproxy '*' -L -sD "$TMP_HEAD" -o "$TMP_BODY" 'https://github.com/fang563094742-svg/wenluDemo/settings/access?guidance_task=' >/dev/null
awk 'toupper($1) ~ /^HTTP\// { code=$2 } END { exit(code==404?0:1) }' "$TMP_HEAD"
grep -Fq 'Not Found' "$TMP_BODY"
