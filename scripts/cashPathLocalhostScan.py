from pathlib import Path

ROOT = Path('/Users/a333/Desktop/cash-path')
KEYS = [
    '127.0.0.1:8899/platform-entry.html',
    '127.0.0.1:8791/',
    'localhost:8899',
    'localhost:8791',
]

for path in sorted(ROOT.glob('*.md')):
    try:
        text = path.read_text()
    except Exception:
        continue
    hits = []
    for line_no, line in enumerate(text.splitlines(), 1):
        if any(key in line for key in KEYS):
            hits.append((line_no, line.strip()))
    if hits:
        print(f'FILE {path.name}')
        for line_no, line in hits:
            print(f'{line_no}: {line}')
        print('---')
