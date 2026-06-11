#!/usr/bin/env python3
import json
import urllib.request
from pathlib import Path

OUT = Path('artifacts/net-h3-gap/net-h3-gap.json')
OUT.parent.mkdir(parents=True, exist_ok=True)
HEADERS = {'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/json,text/plain,*/*'}

def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read(1200).decode('utf-8', 'replace')
        return {
            'url': url,
            'status': getattr(resp, 'status', None),
            'finalUrl': resp.geturl(),
            'headers': dict(resp.headers.items()),
            'bodyPreview': body[:500],
        }

cloudflare_quic = fetch('https://cloudflare-quic.com')
cf_trace = fetch('https://www.cloudflare.com/cdn-cgi/trace')
curl_http3 = fetch('https://curl.se/docs/http3.html')

result = {
    'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
    'claim': 'default urllib can observe remote HTTP/3 capability via alt-svc and docs, while its own fetched transport remains HTTP/1.1',
    'targets': {
        'cloudflare_quic': {
            'status': cloudflare_quic['status'],
            'finalUrl': cloudflare_quic['finalUrl'],
            'altSvc': cloudflare_quic['headers'].get('alt-svc', ''),
            'titleHint': 'QUIC | Cloudflare' in cloudflare_quic['bodyPreview'],
        },
        'cf_trace': {
            'status': cf_trace['status'],
            'httpLinePresent': 'http=http/1.1' in cf_trace['bodyPreview'],
            'warpOff': 'warp=off' in cf_trace['bodyPreview'],
            'gatewayOff': 'gateway=off' in cf_trace['bodyPreview'],
        },
        'curl_http3_doc': {
            'status': curl_http3['status'],
            'finalUrl': curl_http3['finalUrl'],
            'titleHint': 'HTTP/3 with curl' in curl_http3['bodyPreview'],
        }
    }
}
OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
