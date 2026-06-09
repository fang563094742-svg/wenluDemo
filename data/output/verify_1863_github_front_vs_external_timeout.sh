#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1863次呼吸-GitHub当前前台与外部直连阻塞最小现行卡.md"
[ -f "$CARD" ]
grep -Fq 'settings/access?guidance_task=' "$CARD"
grep -Fq 'curl(28) timeout' "$CARD"
grep -Fq '历史旁证' "$CARD"
TMP_OUT="$(mktemp)"
cleanup() {
  rm -f "$TMP_OUT"
}
trap cleanup EXIT
if curl --noproxy '*' -I -L --max-time 20 'https://github.com/fang563094742-svg/wenluDemo/settings/access?guidance_task=' >"$TMP_OUT" 2>&1; then
  exit 1
fi
grep -Eq 'Operation timed out|Connection timed out' "$TMP_OUT"
