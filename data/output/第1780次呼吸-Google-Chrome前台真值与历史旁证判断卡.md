# 第1780次呼吸-Google-Chrome前台真值与历史旁证判断卡

## 当前前台唯一真值
- 应用：Google Chrome
- 标签标题：`codex-chrome-js-ok`
- URL：`data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`
- 结论：当前前台唯一真值已经从 Safari `http://127.0.0.1:3210/` 切换为 Google Chrome 的 `data:` 控制证明页；同主题第一句必须先锁这条真值。

## 历史公开旁证
- 较强可操作壳：视频号助手 `https://channels.weixin.qq.com/platform/post/create`
  - HTTP：`200`
  - 最终 URL：`https://channels.weixin.qq.com/platform/post/create`
  - 正文关键词：`视频号助手`
- 登录壳旁证：微博 visitor `https://login.sina.com.cn/visitor/visitor?...`
  - HTTP：`200`
  - 最终 URL：`https://passport.weibo.com/visitor/visitor?entry=miniblog...`
  - 正文关键词：`Sina Visitor System`
- 公开页旁证：微信 `https://web.wechat.com/`
  - HTTP：`200`
  - 最终 URL：`https://web.wechat.com/`
  - 正文关键词：`WeChat/Weixin for Web`
- 公开页旁证：即刻 `https://web.okjike.com/publish`
  - HTTP：`200`
  - 最终 URL：`https://web.okjike.com/publish`
  - 正文关键词：`即刻`

## 历史失败壳旁证
- 小红书 publish `https://www.xiaohongshu.com/publish/publish`
  - HTTP：`200`
  - 最终 URL：`https://www.xiaohongshu.com/404?source=/publish/publish`
  - 正文关键词：`404`
  - 结论：它只能作为历史失败壳旁证，不能再被写成当前可发页。

## 三条可证伪预测
1. 只要没有新的前台切换证据出现，下一次同主题前台浏览器真值仍会是 Google Chrome 的 `data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`。
2. 若再次对小红书 `publish/publish` 做联网复核，最终 URL 仍会落到 `404?source=/publish/publish`，不会直接回到可发布页。
3. 若再次对视频号 create 与微博 visitor 做联网复核，二者仍会保持“视频号 create 属较强可操作壳、微博 visitor 属登录壳”的分层，而不会取代当前 Chrome `data:` 前台真值。

## 本轮边界
- 这张卡只解决“当前前台真值 vs 历史旁证分层”。
- 这不等于公开发送位已到手，也不等于接近外部结果。
- 本轮外部补锤采用 `urllib` 完整读取正文；此前 `curl` 直取 body 返回空串，已降级为不稳证据，不再沿用。
