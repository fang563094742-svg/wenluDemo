# payment-assets 当前主入口说明

当前真实主入口文件：
- 微信：`wechat-pay.jpg`
- 支付宝：`alipay-pay.jpg`

兼容文件：
- `wechat-pay.png`
- `alipay-pay.png`

使用约定：
1. 对外默认直接发送 `.jpg` 主文件。
2. `data/payment-config.json` 当前已指向 `.jpg` 主文件。
3. 若后续替换真实收款码，优先覆盖主文件名，避免调用端再次改路径。
4. 原始素材或历史版本放入 `backups/` 或 `incoming/`，不要改动主入口命名规则。
