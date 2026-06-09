# Chrome当前前台与历史旁证三层复核卡

生成时间：2026-06-09 09:00 CST

## 当前前台唯一真值
- app=`Google Chrome`
- title=`codex-chrome-js-ok`
- url=`data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`
- 结论：当前前台只认本地 `data:` 页，不认任何历史公开页。

## 历史公开旁证
- 强旁证：`https://channels.weixin.qq.com/platform/post/create`
  - 最终URL应仍包含 `platform/post/create`
  - 正文应命中 `finder-helper-web`
- 中旁证：`https://web.okjike.com/publish`
  - 最终URL应仍包含 `web.okjike.com/publish`
  - 正文应命中 `即刻`
- 登录壳旁证：`https://login.sina.com.cn/visitor/visitor`
  - 最终URL应仍包含 `visitor/visitor`

## 历史失败壳旁证
- `https://www.xiaohongshu.com/publish/publish`
  - 最终URL应落到 `404`
  - 正文应命中 `你访问的页面不见了`

## 单条判断
- 当前前台唯一真值是 Chrome `data:` 页。
- 视频号 create 只属历史强旁证，不是当前页。
- 小红书 publish/publish 只属历史失败壳旁证，不是可用发布页。
