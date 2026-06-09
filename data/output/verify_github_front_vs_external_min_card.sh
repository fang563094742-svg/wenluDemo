#!/bin/sh
set -eu
CARD='/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/github_front_vs_external_min_card_20260609_111941.md'
[ -f "$CARD" ]
grep -Fq 'Current front truth: Google Chrome `https://github.com/fang563094742-svg/wenluDemoWeb/branches`' "$CARD"
grep -Fq 'External direct `branches` check: `404 https://github.com/fang563094742-svg/wenluDemoWeb/branches`' "$CARD"
grep -Fq 'External direct repo root check: `404 https://github.com/fang563094742-svg/wenluDemoWeb`' "$CARD"
grep -Fq 'Current judgment: the current front GitHub page truth and shell-side external direct reachability are separated; front page truth stands, public external existence is not established.' "$CARD"
grep -Fq 'Not Found' /tmp/wenluDemoWeb_branches.html
