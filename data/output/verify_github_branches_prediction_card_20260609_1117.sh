#!/bin/sh
set -eu
CARD='/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/github_branches_prediction_card_20260609_1117.md'
BRANCH_URL='https://github.com/fang563094742-svg/wenluDemo/branches'
HISTORY_URL='https://github.com/fang563094742-svg/wenluDemoWeb/settings/access'
[ -f "$CARD" ]
grep -Fq 'Current front URL: https://github.com/fang563094742-svg/wenluDemo/branches' "$CARD"
grep -Fq 'External direct check for that history URL now returns HTTP 404' "$CARD"
branch_code=$(curl -I -L --max-time 15 --noproxy '*' -s -o /dev/null -w '%{http_code}' "$BRANCH_URL")
[ "$branch_code" != '200' ]
python3 - <<'PY'
import urllib.request, urllib.error, sys
url='https://github.com/fang563094742-svg/wenluDemoWeb/settings/access'
req=urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        code=getattr(r,'status',None)
        sys.exit(0 if code==404 else 1)
except urllib.error.HTTPError as e:
    sys.exit(0 if e.code==404 else 1)
except Exception:
    sys.exit(1)
PY
