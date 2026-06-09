# Safari 3210 历史旁证外部结构化证据卡

生成时间：2026-06-09 08:21 CST

## 当前前台唯一真值
- app: Safari
- title: 问路
- url: http://127.0.0.1:3210/
- 说明：这是当前前台唯一真值；以下网页都只是历史旁证，不能偷换成当前执行页。

## 历史公开旁证

### 1. WeChat Web
- url: https://web.wechat.com/
- finalUrl: https://web.wechat.com/
- httpStatus: 200
- bodyKeywords: 微信, WeChat
- layer: 历史公开旁证
- note: 正文可读且站点首页成立，但不是当前前台页。

### 2. 即刻 publish
- url: https://web.okjike.com/publish
- finalUrl: https://web.okjike.com/publish
- httpStatus: 200
- bodyKeywords: 即刻
- layer: 历史公开旁证
- note: publish 页可达，属于历史公开旁证，不替代当前前台页。

### 3. 视频号助手 create
- url: https://channels.weixin.qq.com/platform/post/create
- finalUrl: https://channels.weixin.qq.com/platform/post/create
- httpStatus: 200
- bodyKeywords: 微信, 视频号助手
- layer: 历史公开旁证-较强可操作壳
- note: 这是历史旁证里较强的可操作壳，但仍不是当前前台页。

### 4. 微博 visitor
- url: https://login.sina.com.cn/visitor/visitor?a=crossdomain&s=_2AkMdeSyxf8NxqwFRm_ARxG3nbotzzQjEieKrJd1qJRMxHRl-yT9yqk1StRB6NvkCXizMI_AX8TgVij9ooT9hjkOthq9g&sp=0033WrSXqPxfM72-Ws9jqgMF55529P9D9W5CdznTJU6UodG8yQaEv2Oy&from=weibo&_rand=0.614295351125&entry=miniblog&url=https%3A%2F%2Fweibo.com%2F
- finalUrl: https://passport.weibo.com/visitor/visitor?entry=miniblog&a=enter&url=https%3A%2F%2Fweibo.com%2F&domain=weibo.com&ua=Mozilla%2F5.0&_rand=1780964486257&sudaref=
- httpStatus: 200
- bodyKeywords: visitor
- layer: 历史公开旁证-登录壳
- note: 这是登录壳旁证，强于微博根页，但不是当前前台页。

## 历史失败壳旁证

### 小红书 publish
- url: https://www.xiaohongshu.com/publish/publish
- finalUrl: https://www.xiaohongshu.com/404?source=/publish/publish
- httpStatus: 200
- bodyKeywords: 小红书
- layer: 历史失败壳旁证
- note: 最终跳到 404 壳，不能再按可用 publish 页处理。

## 结论
- 当前前台唯一真值固定为 Safari `http://127.0.0.1:3210/`。
- 视频号 create、即刻 publish、WeChat Web、微博 visitor 只属于历史公开旁证。
- 小红书 publish/publish 属于历史失败壳旁证。
- 以后同主题第一句若不先锁当前前台唯一真值，就算判断回滑。
