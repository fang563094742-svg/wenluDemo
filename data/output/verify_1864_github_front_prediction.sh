#!/bin/sh
set -eu
ROOT="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo"
CARD="$ROOT/data/output/第1864次呼吸-GitHub当前前台单条可检验预测卡.md"
TMP_DIR="$ROOT/data/output/tmp_github_1864_verify"
mkdir -p "$TMP_DIR"
ACCESS_HEAD="$TMP_DIR/access.head"
ACCESS_BODY="$TMP_DIR/access.body"
ROOT_HEAD="$TMP_DIR/root.head"
ROOT_BODY="$TMP_DIR/root.body"

[ -f "$CARD" ]
grep -Fq '当前前台唯一真值 = `settings/access` 会话内页' "$CARD"
grep -Fq 'https://github.com/fang563094742-svg/wenluDemo/settings/access?guidance_task=' "$CARD"
grep -Fq 'wenluDemo 根页只能作为历史旁证' "$CARD"

curl --noproxy '*' -L -sS -D "$ACCESS_HEAD" -o "$ACCESS_BODY" 'https://github.com/fang563094742-svg/wenluDemo/settings/access?guidance_task='
ACCESS_CODE=$(awk 'toupper($1) ~ /^HTTP\// { code=$2 } END { print code }' "$ACCESS_HEAD")
[ "$ACCESS_CODE" = "404" ]
grep -Fq 'Not Found' "$ACCESS_BODY"

curl --noproxy '*' -L -sS -D "$ROOT_HEAD" -o "$ROOT_BODY" 'https://github.com/fang563094742-svg/wenluDemo'
ROOT_CODE=$(awk 'toupper($1) ~ /^HTTP\// { code=$2 } END { print code }' "$ROOT_HEAD")
[ "$ROOT_CODE" = "404" ]
grep -iq 'wenluDemo' "$ROOT_BODY"
