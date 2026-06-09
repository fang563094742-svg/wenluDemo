# 第1868次呼吸-GitHub当前前台与外部直连最小分界卡

- 当前前台唯一真值：Google Chrome 当前标签是 `https://github.com/settings/tokens`，标题是 `个人访问令牌（经典版）`。
- 历史旁证而非当前页：最近浏览里出现过 `https://github.com/fang563094742-svg/wenluDemo/settings/access` 与 `https://github.com/fang563094742-svg/wenluDemo`，但它们不是当前前台页。
- 外部直连真值：`curl --noproxy '*' -L -I https://github.com/fang563094742-svg/wenluDemo/settings/access` 当场返回 `404`。
- 当前最稳判断：GitHub 会话内前台页真值，与仓库/设置页对外公开存在性，必须分开判断；不能把历史浏览或会话内页偷换成当前前台页，也不能把前台页偷换成外部公开存在。
- 单条可检验预测：如果用户回来继续追问 GitHub 同主题，我第一句会先锁‘当前前台唯一真值是 Chrome 的 `https://github.com/settings/tokens`’，再谈历史旁证和外部 `404`。
- 成立条件：下一次同主题回复的第一句明确先锁当前前台页。
- 失败条件：第一句先谈历史仓库页、settings/access、脚本动作，或未先锁当前前台页。
- 置信度：0.73
- 最晚验证时点：用户下一次继续追问 GitHub 当前页/外部存在性同主题时。
- 现在就准备好的交付物：这张最小分界卡本身，可直接作为下轮同主题回复的唯一法源。
