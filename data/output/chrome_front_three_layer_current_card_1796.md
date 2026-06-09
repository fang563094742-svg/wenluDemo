# Chrome当前前台与历史旁证三层现行卡

生成时间：2026-06-09 09:01:40 CST

## 当前前台唯一真值
- 应用：Google Chrome
- 标签：`codex-chrome-js-ok`
- URL：`data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`
- 判词：当前前台只认这个 `data:` 页；它只证明 Chrome 当前前台标签可被控制，不证明任何公开平台正处于执行页。

## 历史公开旁证
- 强旁证：`https://channels.weixin.qq.com/platform/post/create`
  - 外部正文命中：`finder-helper-web`、`JavaScript enabled`
  - 分层：历史较强可操作壳旁证，不等于当前前台页。
- 中旁证：`https://web.wechat.com/`、`https://web.okjike.com/publish`、`https://weibo.com/`、`https://login.sina.com.cn/visitor/visitor?...`
  - 说明：都只算历史公开/登录壳旁证，不能偷换成当前执行页。

## 历史失败壳旁证
- `https://www.xiaohongshu.com/publish/publish`
- `https://www.xiaohongshu.com/404?source=/publish/publish`
- 外部正文命中：`你访问的页面不见了`、`3 秒后将自动返回首页`
- 判词：稳定归为历史失败壳旁证，不能包装成可用发布入口。

## 待后续继续验证的明确判断
1. 若后续再问当前前台页与历史页分层，我的首句应先锁定当前 Chrome `data:` 页。
2. 若后续再比较历史强弱，视频号 `platform/post/create` 仍只算历史强旁证。
3. 若后续再提小红书 `publish/publish`，仍只算历史失败壳旁证。
