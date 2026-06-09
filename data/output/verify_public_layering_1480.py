import subprocess, sys
checks = [
    ("https://web.wechat.com/", "WeChat/Weixin for Web"),
    ("https://web.okjike.com/publish", "即刻"),
    ("https://weibo.com/", "Sina Visitor System"),
    ("https://www.xiaohongshu.com/publish/publish", "error"),
]
for url, needle in checks:
    r = subprocess.run([
        "curl","--noproxy","*","-L","-s",url
    ], capture_output=True)
    body = r.stdout.decode("utf-8", errors="ignore")
    if needle not in body:
        sys.exit(1)
sys.exit(0)
