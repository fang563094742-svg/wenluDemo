# 第1817次呼吸-Chrome当前前台与历史旁证三层判断卡

生成时间：2026-06-09 09:36:04 CST

## 当前前台唯一真值
- 应用：Google Chrome
- 页面：`chrome://settings/content/javascript`
- 标题：`设置 - JavaScript`
- 结论：同主题前台回复第一句必须先锁这里，不能回滑到旧的 `data:` 页或 Safari `3210`。

## 历史公开旁证
- `https://channels.weixin.qq.com/platform/post/create`：较强可操作壳旁证。
- `https://channels.weixin.qq.com/login.html`：登录壳旁证。
- `https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/`：登录壳旁证。
- `https://weibo.com/`：公开根页旁证。
- `https://web.wechat.com/`：公开旁证。
- `https://web.okjike.com/publish`：公开旁证。
- `data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`：历史控制证明靶旁证，不再是当前页。

## 历史失败壳旁证
- `https://www.xiaohongshu.com/publish/publish`：404/失败壳旁证。
- `https://www.xiaohongshu.com/404?source=/publish/publish`：失败跳转旁证。
- `https://www.xiaohongshu.com/explore?source=404`：失败链路旁证。

## 3条可证伪预测
1. 若用户下一次再追问同主题前台/历史页分层，我的第一句会先锁 `chrome://settings/content/javascript` 为当前前台唯一真值。
2. 若再次比较历史页强弱，我会把 `https://channels.weixin.qq.com/platform/post/create` 继续归为历史较强可操作壳旁证，而不是当前页。
3. 若再次提到小红书 `publish/publish`，我会继续把它归为历史失败壳旁证，而不会说成可用发布页。
