# 第1826次呼吸-Chrome前台真值与历史旁证三层验真卡

生成时间：2026-06-09 09:51 CST

## 当前前台唯一真值
- 应用：Google Chrome
- 窗口：设置 - JavaScript
- 标签：设置 - JavaScript
- URL：`chrome://settings/content/javascript`
- 结论：同主题第一句必须先锁这条当前前台真值，历史页不得偷换。

## 历史公开旁证
- 较强可操作壳：`https://channels.weixin.qq.com/platform/post/create`
  - 最终 URL：`https://channels.weixin.qq.com/platform/post/create`
  - 正文关键词：`finder-helper-web`
- 登录壳旁证：`https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/`
  - 最终 URL：`https://passport.weibo.com/visitor/visitor?...`
  - 正文关键词：`Sina Visitor System`
- 公开可达壳旁证：`https://web.wechat.com/`
  - 正文关键词：`WeChat`
- 公开可达壳旁证：`https://web.okjike.com/publish`
  - 正文关键词：`即刻`

## 历史失败壳旁证
- 失败壳：`https://www.xiaohongshu.com/publish/publish`
  - 最终 URL：`https://www.xiaohongshu.com/404?source=/publish/publish`
  - 正文关键词：`你访问的页面不见了`

## 3条互斥短期预测
1. 触发条件：下次再问当前页和历史页怎么分。
   - 预测：我第一句先锁 `chrome://settings/content/javascript`。
   - 成功：第一句先报当前 Chrome 前台 URL。
   - 失败：第一句先讲历史页、旧 `data:` 页或执行动作。
   - 预计验证：用户下次同主题发问时。
2. 触发条件：下次需要给历史页强弱排序。
   - 预测：我会把 `platform/post/create` 归为历史较强可操作壳，而不是当前页。
   - 成功：明确写“历史较强可操作壳”。
   - 失败：写成当前前台页、当前可发页或失败壳。
   - 预计验证：下一次同主题分层时。
3. 触发条件：下次提到小红书 publish。
   - 预测：我会把它归为历史失败壳旁证。
   - 成功：明确提到 `404` 或“你访问的页面不见了”。
   - 失败：写成可用发布页或公开可发页。
   - 预计验证：下一次同主题提到小红书时。

## 最小区分动作
- 已用远端正文补锤 5 条历史页：视频号 create 命中 `finder-helper-web`，微博 visitor 命中 `Sina Visitor System`，微信 web 命中 `WeChat`，即刻 publish 命中 `即刻`，小红书 404 命中 `你访问的页面不见了`。
- 这一步的目的：把“当前前台真值 / 历史公开旁证 / 历史失败壳旁证”压成可复核单卡，减少我下轮再把历史页偷换成当前页的概率。
