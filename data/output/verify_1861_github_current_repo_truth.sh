#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1861次呼吸-GitHub当前页与外部存在性最小现行卡.md"
[ -f "$CARD" ]
grep -Fq 'https://github.com/fang563094742-svg/wenluDemo' "$CARD"
grep -Fq 'wenluDemoWeb' "$CARD"
TMP_HEAD="$(mktemp)"
TMP_BODY="$(mktemp)"
cleanup() {
  rm -f "$TMP_HEAD" "$TMP_BODY"
}
trap cleanup EXIT
curl --noproxy '*' -L -sD "$TMP_HEAD" -o "$TMP_BODY" 'https://github.com/fang563094742-svg/wenluDemo' >/dev/null
awk 'toupper($1) ~ /^HTTP\// { code=$2 } END { exit(code==200?0:1) }' "$TMP_HEAD"
grep -Fq 'wenluDemo' "$TMP_BODY"
! grep -Fq 'Not Found' "$TMP_BODY"
