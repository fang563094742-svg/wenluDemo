#!/bin/sh
set -eu
CARD="/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1860次呼吸-GitHub当前仓库页验真最小卡.md"
python3 - <<'PY'
from pathlib import Path
import subprocess, sys
card = Path('/Users/a333/Desktop/问路唯一开发的文件夹/问路的弟弟/wenLuDemo/data/output/第1860次呼吸-GitHub当前仓库页验真最小卡.md')
text = card.read_text(encoding='utf-8')
for needle in [
    'https://github.com/fang563094742-svg/wenluDemoWeb',
    '外部直连真值：该 URL 当前返回 `404 Not Found`。',
    '动作前验真最小流程'
]:
    if needle not in text:
        sys.exit(1)
res = subprocess.run([
    'curl','-I','-L','--max-time','20','https://github.com/fang563094742-svg/wenluDemoWeb'
], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
combined = res.stdout + '\n' + res.stderr
sys.exit(0 if 'HTTP/2 404' in combined else 1)
PY
