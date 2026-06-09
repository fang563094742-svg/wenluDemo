# 第1673次呼吸-待主人确认的最小判断校准卡

## 判断命题
- 当前前台唯一真值必须锁定为 Safari `http://127.0.0.1:3210/`。
- 历史公开旁证只能分层引用，不能偷换成当前执行页。
- 历史失败壳旁证必须单列，尤其是小红书 `publish/publish`。

## 依据
- 当前前台浏览器真值：Safari / 问路 / `http://127.0.0.1:3210/`。
- 历史公开旁证（较强可操作壳）：`https://channels.weixin.qq.com/platform/post/create`，外网页面正文命中 `视频号助手是微信为视频号创作者提供内容上传管理、数据查询等功能的专属服务平台。`
- 历史失败壳旁证：`https://www.xiaohongshu.com/publish/publish`，外网页面正文落回错误壳，标题层即为 `你访问的页面不见了` 对应失败页。

## 可观察验证信号
- 这张卡正文同时出现三层标题：`当前前台唯一真值`、`历史公开旁证`、`历史失败壳旁证`。
- 这张卡正文包含当前前台 URL：`http://127.0.0.1:3210/`。
- 外网直连 `channels.weixin.qq.com/platform/post/create` 正文命中 `视频号助手`。
- 外网直连 `xiaohongshu.com/publish/publish` 正文命中 `formula-runtime`，且历史标题旁证已显示这是错误壳页。

## 可能反例
- 如果后续当前前台浏览器真值已切换到别的 URL，这张卡就必须降级，不能再当当前前台页法源。
- 如果视频号 create 页外网正文不再命中 `视频号助手`，它只能降级为更弱历史旁证。
- 如果小红书 publish 页后续不再返回错误壳，而变成真实可用创作页，则它不能继续归入失败壳旁证。

## 主人回来后可直接确认的问题
- 你现在最要我守住的，是不是这条默认动作：同主题第一句先锁定 Safari `http://127.0.0.1:3210/`，再谈历史旁证分层？

## 三层分界
### 当前前台唯一真值
- Safari `http://127.0.0.1:3210/`

### 历史公开旁证
- `https://channels.weixin.qq.com/platform/post/create`：较强可操作壳旁证，不是当前页。
- `https://channels.weixin.qq.com/login.html`：登录壳旁证，弱于 create。
- `https://login.sina.com.cn/visitor/visitor?...`：微博 visitor 登录壳，强于 `https://weibo.com/` 根页，但不是当前页。
- `https://web.wechat.com/`、`https://web.okjike.com/publish`：历史公开可达页，不是当前页。

### 历史失败壳旁证
- `https://www.xiaohongshu.com/publish/publish`
