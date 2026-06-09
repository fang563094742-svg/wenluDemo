#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/chrome_front_three_layer_current_card_1799.md"
JSON="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/chrome_front_three_layer_current_card_1799.json"
python3 - "$CARD" "$JSON" <<'PY'
import json, sys
from pathlib import Path
card = Path(sys.argv[1]).read_text(encoding='utf-8')
data = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
assert '当前前台唯一真值' in card
assert 'data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>' in card
layers = {item['layer']: item for item in data['evidence']}
strong = layers['historical-strong-shell']
login = layers['historical-login-shell']
fail = layers['historical-failure-shell']
assert strong['httpStatus'] == 200 and 'finder-helper-web' in ''.join(strong['keywordsFound'])
assert 'visitor' in login['finalUrl']
assert fail['httpStatus'] == 200 and '你访问的页面不见了' in ''.join(fail['keywordsFound'])
print('ok')
PY
