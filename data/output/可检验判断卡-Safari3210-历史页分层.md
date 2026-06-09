# 可检验判断卡｜Safari 3210 × 历史页分层

生成时间：2026-06-09 07:30 CST

## 目标
把当前前台 Safari `http://127.0.0.1:3210/` 与历史页/公开页证据分层压成单文件，并给出一条外部可验证任务。

## 第一层：当前前台真值
- frontTruth.app=Safari
- frontTruth.title=问路
- frontTruth.url=http://127.0.0.1:3210/
- frontTruth.source=live Safari front tab probe
- 判定：当前执行现场只认这一层，不能被历史页替代。

## 第二层：历史页与公开入口层
- historicalPublicCorroboration=https://web.wechat.com/|https://web.okjike.com/publish|https://channels.weixin.qq.com/platform/post/create|https://weibo.com/|https://www.xiaohongshu.com/publish/publish
- publicDemandScan=artifacts/public-demand-scan-1780943346983
- publicDemandSource=https://sxsapi.com/
- publicDemandTopLead=识别真假冬虫夏草的系统｜https://sxsapi.com/post/860｜待商议｜商议工期｜fit=high
- 判定：这一层只证明公开入口当前可达、公开需求样本已落盘，不证明当前前台正在这些站点，也不证明登录态/可发布态。

## 第三层：分界硬规则
- 当前前台真值只认本轮 Safari 当前标签，不认历史记忆。
- 历史页只作背景与旁证，不能倒推出本轮正在执行它们。
- HTTP 200 只证明入口可达，不证明登录态、发送权或发布权。
- 禁止把 localhost/127.0.0.1 页面冒充成公开外部结果。
- 禁止把历史公开平台足迹冒充成当前前台页。
- 禁止把三层混写成一句“已经可用”。

## 当前判断
- 当前最强现场判断：Safari 当前前台仍是 `http://127.0.0.1:3210/`。
- 当前最强历史旁证判断：公开入口层与 `sxsapi.com` 需求扫描层都已存在并可复核。
- 当前唯一现行动作：凡继续引用“当前页”或“历史页”，都先读本卡，按层陈述，不得越级。

## 外部可验证任务
- goal=Safari 当前前台仍是 3210，五个公开入口同时可达，且最近公开需求扫描旁证仍已落盘。
- verifyCmd=bash task_output/verify_public_layered_frontdesk.sh
- passSignal=退出码 0

## 本轮留证文件
- task_output/front-truth-line/latest-safari-3210-single-source.md
- task_output/public-layered-frontdesk/latest-public-layered-frontdesk.md
- task_output/single-lead-cards/sxsapi-top-leads.md
