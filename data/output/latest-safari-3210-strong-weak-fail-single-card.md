# Safari 3210 当前前台真值与一强一弱一失败历史旁证正文级补锤单卡

生成时间：2026-06-09 07:41 CST

## 当前前台真值
- currentTruth.app=Safari
- currentTruth.title=问路
- currentTruth.url=http://127.0.0.1:3210/
- currentTruth.http=200
- currentTruth.source=live Safari front tab probe + local HTTP probe
- currentTruth.verdict=本轮当前前台正文真值仅是 Safari 正在展示本地问路页，不能外推为任何公开平台正文。

## 一强历史旁证
- strongEvidence.kind=公开扫描落盘且外站仍可访问
- strongEvidence.source=https://sxsapi.com/
- strongEvidence.scanDir=artifacts/public-demand-scan-1780943346983
- strongEvidence.scannedAt=2026/6/9 02:29:06
- strongEvidence.totalParsed=9
- strongEvidence.shortlisted=3
- strongEvidence.topLead=识别真假冬虫夏草的系统
- strongEvidence.topLeadUrl=https://sxsapi.com/post/860
- strongEvidence.meaning=它强在“公开来源当前可访问 + 结构化扫描已落盘 + 能指向具体公开帖子”。
- strongEvidence.boundary=它仍只是历史公开旁证，不是本轮当前前台正文。

## 一弱历史旁证
- weakEvidence.kind=历史公开发布/登录壳足迹
- weakEvidence.links=https://web.wechat.com/|https://web.okjike.com/publish|https://channels.weixin.qq.com/platform/post/create|https://weibo.com/|https://www.xiaohongshu.com/publish/publish
- weakEvidence.meaning=它弱在“只证明曾进入某些公开平台入口或发布壳”。
- weakEvidence.boundary=不能据此推出当前就在这些平台写正文、发正文或完成发布。

## 一失败旁证
- failedEvidence.kind=失败壳越级
- failedEvidence.claim=把历史发布壳/登录壳直接说成当前正在操作的正文页
- failedEvidence.whyFail=当前前台实时探针已经给出 Safari 真实 URL 是 http://127.0.0.1:3210/；因此任何把历史壳层足迹包装成当前正文的说法都会与现场真值冲突。
- failedEvidence.rule=失败壳只能作为反例补锤：壳层证据不得越级冒充正文级结论。

## 正文级补锤结论
- bodyLevelLaw=凡正文级陈述，先锁当前前台 Safari 标签的标题与 URL；只有它能代表本轮现场正文。
- shellLevelLaw=历史公开旁证分强弱保存：强旁证可证明“公开来源存在且曾被结构化抓到”，弱旁证只证明“曾进入入口/壳”。
- failureLaw=一旦当前真值与历史壳层冲突，必须以前台实时真值为准，并把壳层叙述降级为背景。

## 外部可验证闭环
- claim=当前前台真值是 Safari 的 http://127.0.0.1:3210/；强旁证是 sxsapi 公开扫描落盘并指向 post/860；弱旁证是历史平台入口足迹；失败旁证是“历史壳越级冒充当前正文”且已被现场真值否掉。
- verifyCommand=test "$(osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true')" = "Safari" && test "$(osascript -e 'tell application \"Safari\" to if it is running then get URL of current tab of front window')" = "http://127.0.0.1:3210/" && curl -fsS http://127.0.0.1:3210/ | rg '<title>问路</title>' >/dev/null && curl -fsS https://sxsapi.com/ | rg '斗包网-互联网软件外包平台' >/dev/null && test -f artifacts/public-demand-scan-1780943346983/scan.json && rg 'https://sxsapi.com/post/860' artifacts/public-demand-scan-1780943346983/scan.json >/dev/null && grep -F 'weakEvidence.links=https://web.wechat.com/|https://web.okjike.com/publish|https://channels.weixin.qq.com/platform/post/create|https://weibo.com/|https://www.xiaohongshu.com/publish/publish' task_output/front-truth-line/latest-safari-3210-strong-weak-fail-single-card.md >/dev/null && grep -F 'failedEvidence.claim=把历史发布壳/登录壳直接说成当前正在操作的正文页' task_output/front-truth-line/latest-safari-3210-strong-weak-fail-single-card.md >/dev/null
- passSignal=退出码 0
