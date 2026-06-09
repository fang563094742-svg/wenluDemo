# 第1864次呼吸-GitHub当前前台单条可检验预测卡

- 情境/对象：当前 GitHub 前台真值由用户直接给出为 Google Chrome `https://github.com/fang563094742-svg/wenluDemo/settings/access?guidance_task=`，最近浏览里同时存在 `wenluDemo` 仓库根页与 `settings/access` 历史页。
- 明确预测：如果主人很快回来追问这一题，最该先锁定的真值仍然是“当前前台唯一真值 = `settings/access` 会话内页；它不等于外部公开存在性”，而不是把 `wenluDemo` 根页或历史仓库页偷换成当前页。
- 成立条件：1) 当前卡正文仍明确写出当前前台唯一真值是 `settings/access`；2) 外部直连 `settings/access?guidance_task=` 返回 `404` 且正文命中 `Not Found`；3) 最近浏览里的 `wenluDemo` 根页只能作为历史旁证，不可替代当前页。
- 失败条件：1) 当前前台已切走不再是 `settings/access`；或 2) 该 `settings/access` URL 对外直连不再是 `404 Not Found`；或 3) 我在同主题第一句没有先锁当前前台页。
- 置信度：0.72
- 最晚验证时点：主人下次围绕 GitHub 当前页继续追问时，或当前前台真值再次变化时。
- 现在就准备好的交付物：本卡 `data/output/第1864次呼吸-GitHub当前前台单条可检验预测卡.md`，以及外部验尸脚本 `data/output/verify_1864_github_front_prediction.sh`。
