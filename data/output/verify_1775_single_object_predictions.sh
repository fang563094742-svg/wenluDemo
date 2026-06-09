#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1775次呼吸-单对象3条可证伪判断卡.md"
[ -f "$CARD" ]
grep -F '对象：当前前台 Safari 3210 真值' "$CARD" >/dev/null
grep -F 'URL：http://127.0.0.1:3210/' "$CARD" >/dev/null
grep -F '1. 只要用户下一次继续围绕“当前前台页/历史旁证分层”发问' "$CARD" >/dev/null
grep -F '3. 在新前台真值出现前，历史旁证将继续只作为旁证分层，不会被升级成当前执行页。' "$CARD" >/dev/null
