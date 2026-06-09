# Safari 3210 结构化外部证据卡

生成时间：2026-06-09 08:27:20 CST

## 最终现场真值
- finalApp=Safari
- finalTitle=问路
- finalURL=http://127.0.0.1:3210/
- finalHTTPStatus=200 OK
- finalHTTPHeader.Content-Type=text/html;charset=utf-8
- finalBodyKeywords=问路
- finalTruthSource=live Safari front tab probe + local HTTP fetch

## 历史旁证
- priorEvidenceFile=task_output/front-truth-line/latest-safari-3210-layered-single-card.md
- priorBoundaryFile=task_output/front-truth-line/latest-front-truth-boundary-chain.md
- priorClaim=此前已记录当前前台 Safari 指向 http://127.0.0.1:3210/，并明确历史公开平台链接仅作壳层旁证。
- priorHistoricalCorroboration=https://web.wechat.com/|https://web.okjike.com/publish|https://channels.weixin.qq.com/platform/post/create|https://weibo.com/|https://www.xiaohongshu.com/publish/publish

## 分层说明
- layer1CurrentTruth=本轮唯一正文级真值来自当前前台 Safari 标签页与对该 URL 的实时 HTTP 抓取。
- layer2HistoricalCorroboration=仓库内旧卡片与边界链提供历史旁证，证明这条任务线此前已多次锁定同一 Safari 3210 页面。
- layer3Boundary=历史公开平台入口只说明曾观察到发布壳或入口，不得越级推导成当前正文、当前发布对象或当前外部平台结果。
- layer4Conclusion=因此本轮可落地的外部证据结论是：当前前台 Safari 真值为本地 `http://127.0.0.1:3210/` 的“问路”页面，HTTP 返回 200，正文关键词命中“问路”。

## 取证命令
- safariURL=osascript -e 'tell application "Safari" to if (count of windows) > 0 then return URL of current tab of front window'
- safariTitle=osascript -e 'tell application "Safari" to if (count of windows) > 0 then return name of current tab of front window'
- httpProbe=curl -i -s http://127.0.0.1:3210/
- bodyKeywordProbe=curl -s http://127.0.0.1:3210/ | tr '\n' ' ' | sed 's/<[^>]*>/ /g' | tr -s ' ' | rg '问路'
