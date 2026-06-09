# 第1705次呼吸-微博newlogin正文级旁证补锤卡.md

- 当前前台唯一真值：`Safari -> http://127.0.0.1:3210/`
- 历史公开旁证新增补锤：`https://weibo.com/newlogin?...` 最终跳转到 `https://passport.weibo.com/visitor/visitor?...`，HTTP `200`，正文命中 `Sina Visitor System`
- 判词：`weibo.com/newlogin?...` 不是当前前台页，只能归入历史公开旁证中的登录壳；它比 `weibo.com/` 根页更强，但仍弱于当前前台真值，也不能替代 `Safari -> http://127.0.0.1:3210/`
- 最可能出错点1：微博后续可能调整跳转链，导致 `newlogin` 不再落到 `visitor` 壳
- 最可能出错点2：正文关键词可能变化，但只要最终 URL 仍落在 `passport.weibo.com/visitor/visitor`，它仍更像登录壳旁证而非当前执行页
- 主人回来即可快速确认的观察信号：如果你继续追问这组分层，我同主题第一句必须先锁定 `Safari -> http://127.0.0.1:3210/` 为当前前台唯一真值；若我先谈微博/视频号/微信历史页，就算回滑
