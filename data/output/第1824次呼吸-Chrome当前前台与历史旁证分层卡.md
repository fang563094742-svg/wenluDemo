# 第1824次呼吸-Chrome当前前台与历史旁证分层卡

生成时间：2026-06-09 09:44 CST

## 当前前台唯一真值
- 应用：Google Chrome
- 窗口：设置 - JavaScript
- 标签：设置 - JavaScript
- URL：`chrome://settings/content/javascript`
- 边界：这只证明当前前台 Chrome 停在 JavaScript 设置页，不证明任何外部发布页当前正在前台可发。

## 历史公开旁证
- 较强可操作壳：`https://channels.weixin.qq.com/platform/post/create`
  - 正文补锤：公开正文命中 `finder-helper-web`，说明它至少是视频号助手前端壳。
- 登录壳旁证：`https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/`
  - 历史标题仍指向微博登录层，不能偷换成当前前台页。
- 公开可达壳旁证：`https://web.wechat.com/`、`https://web.okjike.com/publish`
  - 这两条只算历史可达旁证，不等于当前执行页。

## 历史失败壳旁证
- `https://www.xiaohongshu.com/publish/publish`
- `https://www.xiaohongshu.com/404?source=/publish/publish`
- 正文补锤：命中 `你访问的页面不见了`，因此稳定归为失败壳旁证。

## 当前现行判断
- 当前前台唯一真值只认 `Google Chrome` 的 `chrome://settings/content/javascript`。
- 视频号 create 最多是历史较强壳旁证，微博 visitor/login 是登录壳旁证，微信 web 与即刻 publish 是公开可达壳旁证。
- 小红书 publish/publish 是失败壳旁证，不能再包装成当前页或可用发布页。
- 同主题前台回复第一句必须先锁当前前台唯一真值，再谈历史旁证分层。

## 待验证预测
1. 如果用户下次同主题追问，我的第一句会先锁 `Google Chrome` 当前前台 `chrome://settings/content/javascript`。
2. 如果再次比较历史旁证强弱，我会继续把视频号 create 归为历史较强壳旁证，而不是当前页。
3. 如果再次提到小红书 publish/publish，我会继续把它归为历史失败壳旁证，而不是可用发布页。
