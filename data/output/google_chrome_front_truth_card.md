# Google Chrome 当前前台真值与历史旁证分界卡

- 记录时间: 2026-06-09 08:30 CST
- 当前前台应用: Google Chrome
- 当前前台唯一真值: `data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`
- 当前窗口标题: `codex-chrome-js-ok`
- 结论: 先前把 Safari `http://127.0.0.1:3210/` 作为当前前台唯一真值的口径已失效；它现在最多只可视为历史旧真值，不再是当前前台页。

## 当前前台真值

1. `osascript task_output/chrome_applescript_verify.applescript` 返回 `OK|codex-chrome-js-ok`。
2. `osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'` 返回 `data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`。
3. 因此，当前前台唯一真值已切换到 Google Chrome 的 `codex-chrome-js-ok` data 页面。

## 历史旁证（非当前页）

- WeChat/Weixin for Web: `https://web.wechat.com/`
- 即刻 publish: `https://web.okjike.com/publish`
- 视频号 create: `https://channels.weixin.qq.com/platform/post/create`
- 微博 visitor/login 壳: `https://login.sina.com.cn/visitor/visitor...`
- 小红书失败壳: `https://www.xiaohongshu.com/publish/publish`

## 默认动作约束

- 后续同主题第一句，必须先锁定“当前前台唯一真值 = Google Chrome data: codex-chrome-js-ok”。
- WeChat、即刻、视频号、微博、小红书只能作为历史旁证，不得再偷换成当前前台页。
- Safari `http://127.0.0.1:3210/` 也只能按历史旧真值处理，直到新的前台验证再次把它抬回当前页。
