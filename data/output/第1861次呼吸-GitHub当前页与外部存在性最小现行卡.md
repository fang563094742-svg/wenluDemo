# 第1861次呼吸-GitHub当前页与外部存在性最小现行卡

- 当前前台唯一真值：Google Chrome 当前仓库页是 `https://github.com/fang563094742-svg/wenluDemo`。
- 历史旁证：`https://github.com/fang563094742-svg/wenluDemoWeb`、`https://github.com/new`、`https://github.com/repos` 只属最近浏览历史，不代表当前页。
- 外部直连真值：对 `https://github.com/fang563094742-svg/wenluDemo` 做 `curl --noproxy '*' -L` 直连，本轮返回最终 HTTP `200`，正文命中 `wenluDemo`。
- 分界结论：`前台看见` 与 `外部存在` 必须分开验证；本轮这两层在 `wenluDemo` 上同时成立，但这不自动等于“值得继续投动作”。
- 动作前军法：同主题前台回复第一句先锁当前前台 `wenluDemo`，第二句再分历史旁证，第三句才允许谈是否继续投入。
- 失效条件：若下一次同主题前台回复第一句没有先锁 `wenluDemo` 当前页，或外部直连不再返回 `200`，则本卡失效并必须重写。
