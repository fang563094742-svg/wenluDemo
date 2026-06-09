# Chrome当前前台与历史旁证三层判断卡

生成时间：2026-06-09 10:05 CST

## 当前前台唯一真值
- 应用：Google Chrome
- 标签标题：`设置 - JavaScript`
- URL：`chrome://settings/content/javascript`
- 结论：当前前台唯一真值只认这条 Chrome 设置页；它证明的是当前 Chrome 前台页面，不证明任何公开平台当前处于可发态。

## 历史公开旁证
- 较强可操作壳：`https://channels.weixin.qq.com/platform/post/create`
  - 历史标题：`视频号助手`
  - 分层结论：这是历史公开旁证里的较强可操作壳，不是当前前台页。
- 登录壳旁证：`https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/`
  - 历史标题：`微博 – 随时随地发现新鲜事`
  - 分层结论：这是历史公开旁证里的登录壳，不是当前前台页。
- 公开可达壳旁证：`https://web.wechat.com/`、`https://web.okjike.com/publish`
  - 历史标题：`WeChat/Weixin for Web`、`即刻`
  - 分层结论：这两条只说明历史上访问过公开壳页面，不证明当前前台执行态。

## 历史失败壳旁证
- `https://www.xiaohongshu.com/publish/publish`
- `https://www.xiaohongshu.com/404?source=/publish/publish`
- 分层结论：这组历史页属于失败壳/404 旁证，不得包装成可用发布页，更不能替代当前前台真值。

## 3条可证伪预测
1. 如果下次同主题再追问当前页与历史页分层，我的第一句必须先锁定：当前前台唯一真值是 `Google Chrome` 的 `chrome://settings/content/javascript`。
   - 触发条件：用户下次继续追问同主题分层。
   - 成功判据：第一句先明确写出上述当前前台真值。
   - 失败判据：第一句先讲历史页、旧 `data:` 页、或未先锁当前前台真值。
   - 预计验证时间：下次同主题追问时。
2. 如果下次需要比较历史页强弱，我会把 `https://channels.weixin.qq.com/platform/post/create` 继续归为“历史较强可操作壳旁证”，不会把它写成当前前台页。
   - 触发条件：用户追问历史页强弱或可操作性。
   - 成功判据：明确把它归在历史公开旁证层。
   - 失败判据：把它写成当前前台页、或把它降成失败壳。
   - 预计验证时间：下次同主题强弱比较时。
3. 如果下次再提到小红书历史页，我会继续把 `publish/publish` 与其 `404` 跳转页归为“历史失败壳旁证”，不会说成可用发布页。
   - 触发条件：用户再次提到小红书历史页。
   - 成功判据：继续明确写为失败壳/404 旁证。
   - 失败判据：把它说成当前页、强旁证或可用发布页。
   - 预计验证时间：下次再提小红书历史页时。

## 最小行动
- 先用一条外部正文级验证脚本同时补锤三类历史页：视频号 create 壳、微博 visitor/newlogin 登录壳、小红书 404 失败壳；并与本地判断卡里的当前前台真值一并验穿。
