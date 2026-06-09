# Chrome当前前台三层判断卡

生成时间：2026-06-09 08:38 CST

## 当前前台唯一真值
- 应用：`Google Chrome`
- 标签标题：`codex-chrome-js-ok`
- URL：`data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`
- 判词：这只证明当前 Chrome 前台是本地 `data:` 控制证明页，不证明任何公开平台当前正在前台执行。

## 历史公开旁证
- 强旁证：`https://channels.weixin.qq.com/platform/post/create`
  - finalUrl：`https://channels.weixin.qq.com/platform/post/create`
  - 正文关键词：`finder-helper-web`、`JavaScript enabled`
  - 分层：历史公开旁证中的较强可操作壳，不能偷换成当前前台页。
- 中旁证：`https://web.okjike.com/publish`
  - finalUrl：`https://web.okjike.com/publish`
  - 正文关键词：`即刻`、`聊AI，聊科技的人都在这里`
  - 分层：历史公开旁证中的公开壳。
- 中旁证：`https://web.wechat.com/`
  - finalUrl：`https://web.wechat.com/`
  - 正文关键词：`WeChat`
  - 分层：历史公开旁证中的登录壳。
- 中旁证：`https://login.sina.com.cn/visitor/visitor?...`
  - finalUrl：`https://passport.weibo.com/visitor/visitor?entry=miniblog...`
  - 正文关键词：`visitor`、`weibo`
  - 分层：历史公开旁证中的登录壳。

## 历史失败壳旁证
- `https://www.xiaohongshu.com/publish/publish`
  - finalUrl：`https://www.xiaohongshu.com/404?source=/publish/publish`
  - 正文关键词：`你访问的页面不见了`、`自动返回首页`
  - 分层：历史失败壳旁证，不能包装成可用发布页。

## 本轮最小判断
- 当前现行只认 Chrome 前台 `data:` 页。
- 视频号 `platform/post/create` 仍是历史公开旁证里最强的一层，但仅是较强壳，不是当前页。
- 小红书 `publish/publish` 已被最终 URL 与正文关键词双证压实为失败壳旁证。

## 3条可证伪预测
1. 若后续同主题再次追问现行页与历史页分层，我的首句会先锁定当前 `Google Chrome` 前台 `data:` 页。
   - 成功信号：首句先写当前 Chrome `data:` 页。
   - 失败信号：首句先讲视频号、即刻、微信、微博或小红书历史页。
2. 若后续比较历史页强弱，我会继续把 `https://channels.weixin.qq.com/platform/post/create` 归为历史公开旁证中的较强可操作壳，而不是当前页。
   - 成功信号：继续写成历史强旁证。
   - 失败信号：写成当前前台页，或降成失败壳。
3. 若后续再次提到小红书 `publish/publish`，我会继续把它归为历史失败壳旁证，而不是可用发布入口。
   - 成功信号：继续写成失败壳/404壳。
   - 失败信号：写成可用发布页、当前页或较强旁证。

## 外部补锤结论
- 本轮外部正文补锤不再沿用旧口头：只认当场抓回的 `finalUrl + bodyKeywords`。
- 视频号 create、即刻 publish、小红书 publish/publish、微信 web、微博 visitor 都已补到外部正文或最终 URL 真值，但它们全部只属于历史旁证层，不替代当前前台 Chrome `data:` 页。
