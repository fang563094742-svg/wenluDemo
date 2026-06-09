# Chrome前台真值与历史旁证分层最小判断卡

生成时间：2026-06-09 10:14:30 CST

## 当前Chrome前台唯一真值
- app=`Google Chrome`
- title=`设置 - JavaScript`
- url=`chrome://settings/content/javascript`
- 边界：这条真值只证明当前前台 Chrome 标签页是 JavaScript 设置页，不证明任何公开平台发帖页正在前台。

## 历史公开旁证
- 历史较强可操作壳：`https://channels.weixin.qq.com/platform/post/create`
  - 分层：历史公开旁证，不是当前页。
  - 外部正文级补锤：正文命中 `finder-helper-web` 与 `JavaScript enabled`，说明它是视频号助手前端壳。
- 历史登录壳旁证：`https://weibo.com/newlogin?tabtype=weibo&gid=102803&openLoginLayer=0&url=https://weibo.com/`
  - 分层：历史公开旁证，不是当前页。
  - 外部正文级补锤：最终 URL 仍落在 `visitor` 登录链，属登录壳旁证。
- 历史公开壳旁证：`https://web.wechat.com/` 与 `https://web.okjike.com/publish`
  - 分层：历史公开旁证，不是当前页。
  - 外部正文级补锤：`web.okjike.com/publish` 正文命中 `即刻`，只能证明公开壳名可达。

## 历史失败壳旁证
- `https://www.xiaohongshu.com/publish/publish`
- `https://www.xiaohongshu.com/404?source=/publish/publish`
- 分层：历史失败壳旁证。
- 外部正文级补锤：正文命中 `你访问的页面不见了` 与 `3 秒后将自动返回首页`，不能包装成可用发布页。

## 最小判断
- 当前前台唯一真值只认 `Google Chrome` 的 `chrome://settings/content/javascript`。
- 视频号 `platform/post/create` 只属历史较强可操作壳旁证。
- 微博 `visitor` 只属历史登录壳旁证。
- 小红书 `publish/publish` 只属历史失败壳旁证。
- 任何历史 URL 都不能偷换成当前前台执行页。

## 3条可证伪预测
1. 触发条件：下次同主题再次追问当前页与历史页分层。
   - 预期结果：我的第一句会先锁 `Google Chrome` 当前前台 `chrome://settings/content/javascript`。
   - 置信度：0.62
   - 最晚验证时间：下次用户同主题追问时。
   - 错了说明什么：说明我仍会把历史旁证偷换成当前页，判断门闩没真正进默认动作。
2. 触发条件：下次需要比较历史公开页强弱。
   - 预期结果：我会把 `https://channels.weixin.qq.com/platform/post/create` 归为历史较强可操作壳旁证，不会写成当前页。
   - 置信度：0.68
   - 最晚验证时间：下次同主题比较历史页强弱时。
   - 错了说明什么：说明我还没把“当前前台真值优先”与“历史旁证分层”真正切开。
3. 触发条件：下次再次提到小红书 `publish/publish`。
   - 预期结果：我会继续把它归为历史失败壳旁证，不会说成可用发布页。
   - 置信度：0.78
   - 最晚验证时间：下次同主题提到该 URL 时。
   - 错了说明什么：说明我对失败壳的处决仍不稳，容易被旧印象拉回。

## 本次方法假设
- 这次比过去更可能命中的原因：不再只凭浏览历史标题或 HTTP 200，下判断前同时要求三件事站住：当前前台真值、最终 URL/分层、外部正文关键词。这样能把“当前页”“历史公开壳”“历史失败壳”切得更硬。
