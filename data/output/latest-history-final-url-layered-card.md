# 第1617次呼吸-历史页最终URL三证分层卡

时间：2026-06-09 04:09:54 CST

## 目标
对当前这批历史页做外部补锤，补齐每条链接的最终 URL、HTTP 状态与正文关键词，并生成单文件分层卡，供后续判断直接复用。

## 当前前台边界
- 当前前台真值仍应单独锚定，不可把下面任何历史页偷换成当前执行页。
- 下面全部对象都只是历史公开页/历史登录壳/历史失败壳的旁证。

## 历史页三证补锤结果

### A. 微信网页版
- 原始 URL：`https://web.wechat.com/`
- 最终 URL：`https://web.wechat.com/`
- HTTP 状态：`200`
- 正文关键词：`WeChat/Weixin for Web`、`微信`、`Scan to log in`
- 分层：**历史公开登录壳旁证**
- 备注：页面主体存在，但核心动作仍指向扫码登录。

### B. 即刻 publish
- 原始 URL：`https://web.okjike.com/publish`
- 最终 URL：`https://web.okjike.com/publish`
- HTTP 状态：`200`
- 正文关键词：`即刻`
- 分层：**历史公开页弱旁证**
- 备注：能直达，但无强正文细节；只证明该路径当前可返回页面。

### C. 视频号 create
- 原始 URL：`https://channels.weixin.qq.com/platform/post/create`
- 最终 URL：`https://channels.weixin.qq.com/platform/post/create`
- HTTP 状态：`200`
- 正文关键词：`视频号助手`、`finder-helper-web`
- 分层：**历史公开创建壳强旁证**
- 备注：页面主体明确，强于泛入口与登录壳，但仍不是当前前台执行页。

### D. 微博根页
- 原始 URL：`https://weibo.com/`
- 最终 URL：`https://passport.weibo.com/visitor/visitor?entry=miniblog&a=enter&url=https%3A%2F%2Fweibo.com%2F&domain=weibo.com&ua=Mozilla%2F5.0%20WenLuHistoryProbe%2F1.0&_rand=1780949388457&sudaref=`
- HTTP 状态：`200`
- 正文关键词：`Sina Visitor System`、`visitor`
- 分层：**历史登录壳旁证**
- 备注：最终跳到 visitor 系统，不能写成可直接发布页。

### E. 小红书 publish
- 原始 URL：`https://www.xiaohongshu.com/publish/publish`
- 最终 URL：`https://www.xiaohongshu.com/404?source=/publish/publish`
- HTTP 状态：`200`
- 正文关键词：`你访问的页面不见了`、`404`、`小红书`
- 分层：**历史失败壳旁证**
- 备注：虽然最终状态码仍是 200，但正文明确是 404 页面壳。

## 最终分层判词
- 最强历史公开壳：`https://channels.weixin.qq.com/platform/post/create`
- 公开但偏登录壳：`https://web.wechat.com/`、`https://weibo.com/`
- 公开弱旁证：`https://web.okjike.com/publish`
- 明确失败壳：`https://www.xiaohongshu.com/publish/publish`

## 复用规则
- 后续凡引用这批历史页，默认必须同时带出 `最终 URL + HTTP 状态 + 正文关键词` 三证。
- 若只给原始 URL 或只给状态码，不足以支撑执行判断。
- 特别是小红书这类页面，`HTTP 200` 不能自动等于“页可用”，必须结合最终 URL 与正文关键词判定。

## 可验证任务
- goal: 历史页最终 URL 三证分层卡已生成并含 5 条链接的最终 URL、状态与正文关键词
- verifyCommand: `test -f task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md && grep -F 'https://channels.weixin.qq.com/platform/post/create' task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null && grep -F '最终 URL：`https://passport.weibo.com/visitor/visitor' task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null && grep -F '正文关键词：`你访问的页面不见了`、`404`、`小红书`' task_output/public-layered-frontdesk/latest-history-final-url-layered-card.md >/dev/null`
