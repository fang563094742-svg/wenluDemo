# 第1778次呼吸-Chrome前台真值与历史旁证分层最小判断卡

生成时间：2026-06-09 08:33:20 CST

## 当前Chrome前台唯一真值
- app=Google Chrome
- title=`codex-chrome-js-ok`
- url=`data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`
- 边界：这条真值只证明当前Chrome前台标签是一个本地注入的 `data:` 页面，不证明任何外部站点正在前台执行。

## 历史旁证分层
- 历史强旁证：`https://channels.weixin.qq.com/platform/post/create`
  - 含义：最近历史里出现过视频号创作入口壳，可作为“曾到过较强可操作入口”的旁证。
- 历史中旁证：`https://web.wechat.com/`、`https://web.okjike.com/publish`、`https://login.sina.com.cn/visitor/visitor?...`、`https://weibo.com/`
  - 含义：只证明最近历史中出现过登录壳或公开入口，不等于当前前台执行页。
- 历史失败旁证：`https://www.xiaohongshu.com/publish/publish` 与 `https://www.xiaohongshu.com/404?source=/publish/publish`
  - 含义：最近历史明确显示小红书发布入口落到失败壳/404，不能包装成可用发布页。

## 最小判断
- 当前Chrome前台真值与历史旁证必须分层：当前只认 `data:` 前台页；历史里最强的是视频号 `create` 壳；小红书 `publish/publish` 只算失败旁证。
- 禁止跳跃：不能把任何历史 URL 偷换成当前Chrome前台页，也不能把当前 `data:` 页包装成外部平台执行结果。

## 3条可证伪预测
1. 预测对象：我下一次同主题首句。
   - 明确结论：若用户继续追问“当前Chrome前台页与历史页哪个算现行”，我的第一句会先锁定 `Google Chrome` 当前前台 `data:` 页，而不是先讲历史站点。
   - 触发条件：用户下一次继续问当前Chrome前台真值、历史旁证分层或现行判词。
   - 验证时点：该次回复一发出即可检查第一句。
   - 判错标准：若第一句先写视频号、微博、微信、小红书等历史站点，或把历史页写成当前页，则判错。
2. 预测对象：视频号 `create` 的分层口径。
   - 明确结论：我会把 `https://channels.weixin.qq.com/platform/post/create` 稳定归为“历史强旁证”，不会写成当前Chrome前台页。
   - 触发条件：下次需要比较历史页强弱或说明哪个历史页最接近可操作入口时。
   - 验证时点：该句出现时即可检查。
   - 判错标准：若我把它说成当前Chrome前台页，或降成失败旁证，则判错。
3. 预测对象：小红书 `publish/publish` 的口径。
   - 明确结论：我会继续把它归为“历史失败旁证/404 壳”，不会说成可用发布页。
   - 触发条件：下次提到小红书历史页时。
   - 验证时点：该句出现时即可检查。
   - 判错标准：若我把它说成当前页、强旁证或可发布入口，则判错。

## 本轮证据
- 前台真值：`osascript` 读取到前台应用为 `Google Chrome`，活动标签为 `codex-chrome-js-ok`，URL 为 `data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`。
- 历史旁证：复制 Chrome `History` 数据库后查询最近访问记录，命中视频号 `create`、微信 web、即刻 publish、微博 visitor/weibo、小红书 publish/404。
- 数据库原件处于锁定中；本轮通过只读复制后查询，避免对运行中的 Chrome 历史库做破坏性操作。
