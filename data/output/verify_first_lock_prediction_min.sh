#!/bin/sh
set -eu
CARD="$1"
[ -f "$CARD" ]
grep -F '## 预测对象' "$CARD" >/dev/null
grep -F '当前前台唯一真值仍是 Safari `http://127.0.0.1:3210/`' "$CARD" >/dev/null
grep -F '## 3条触发依据' "$CARD" >/dev/null
grep -F '## 2个可能证伪信号' "$CARD" >/dev/null
grep -F '小红书 publish/publish 是历史失败壳旁证' "$CARD" >/dev/null
