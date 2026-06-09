# 第1815次呼吸-Chrome当前前台三层判断卡

## 当前前台唯一真值
- 应用：Google Chrome
- 页面：`chrome://settings/content/javascript`
- 标题：设置 - JavaScript
- 结论：这是当前前台唯一真值，后续同主题第一句必须先锁这里。

## 历史公开旁证
- `https://channels.weixin.qq.com/platform/post/create`：较强可操作壳旁证。
- `https://channels.weixin.qq.com/login.html`：登录壳旁证。
- `https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/`：登录壳旁证。
- `https://weibo.com/`：历史公开旁证。
- `https://web.wechat.com/`：历史公开旁证。
- `https://web.okjike.com/publish`：历史公开旁证。
- `data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`：历史控制证明靶。

## 历史失败壳旁证
- `https://www.xiaohongshu.com/publish/publish`：失败壳旁证。
- `https://www.xiaohongshu.com/404?source=/publish/publish`：失败壳旁证。
- `https://www.xiaohongshu.com/explore?source=404`：失败链路旁证。

## 当前判断
- 不得把任何历史页偷换成当前执行页。
- 同主题前台回复第一句，必须先锁 `chrome://settings/content/javascript`。
