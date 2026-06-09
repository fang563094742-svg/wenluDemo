# 第1866次呼吸-GitHub当前前台与外部存在性判断卡

- 当前前台唯一真值：用户刚给出的当前页与剪贴板都指向 `https://github.com/login/device/select_account`。
- 当前页分层：这是一条 GitHub 设备验证/选账户链上的当前前台页，不是仓库根页，也不是 `settings/access` 仓库设置页。
- 历史旁证：`https://github.com/fang563094742-svg/wenluDemo/settings/access`、`https://github.com/fang563094742-svg/wenluDemo`、`https://github.com/login/device?skip_account_picker=true` 只属最近浏览历史，不代表当前页。
- 外部真值：`/fang563094742-svg/wenluDemo/settings/access` 与 `/fang563094742-svg/wenluDemo` 本轮外部直连都返回 `404`；`https://github.com/login/device/select_account` 外部直连最终落到 GitHub 登录页并返回 `200`。
- 现行判断：当前前台真值成立，但它只能证明“浏览器此刻停在 GitHub 设备验证链页”，不能证明该仓库外部公开存在，更不能继续沿用旧的 `wenluDemo#` 当前页口径。
- 单条可检验预测：如果主人下一次继续问这个同主题，我第一句会先锁 `https://github.com/login/device/select_account` 是当前前台唯一真值，再谈仓库外部 `404` 与历史页分层；若我先讲仓库或历史页，这条判断落空。

## 本轮外部补锤
- 当前前台页历史旁证：源 URL `https://github.com/login/device/select_account`；最终 URL `https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Flogin%2Fdevice%2Fselect_account`；HTTP `200`；正文预览 `        <!DOCTYPE html> <html   lang="en"     class="html-auth"      data-color-mode="auto" data-light-theme="light" data-dark-theme="dark"   data-a11y-animated-images="system" data-a11y-link-underlines="true"      >    `
- access外部直连：源 URL `https://github.com/fang563094742-svg/wenluDemo/settings/access`；最终 URL `https://github.com/fang563094742-svg/wenluDemo/settings/access`；HTTP `404`；正文预览 `        <!DOCTYPE html> <html   lang="en"      data-color-mode="auto" data-light-theme="light" data-dark-theme="dark"   data-a11y-animated-images="system" data-a11y-link-underlines="true"      >       <head>     <meta ch`
- repo外部直连：源 URL `https://github.com/fang563094742-svg/wenluDemo`；最终 URL `https://github.com/fang563094742-svg/wenluDemo`；HTTP `404`；正文预览 `        <!DOCTYPE html> <html   lang="en"      data-color-mode="auto" data-light-theme="light" data-dark-theme="dark"   data-a11y-animated-images="system" data-a11y-link-underlines="true"      >       <head>     <meta ch`
