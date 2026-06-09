# Chrome current front truth layered judgment card

GeneratedAt: 2026-06-09 08:44 CST

## Current front truth
- Current front app: Google Chrome
- Current front window/title: `codex-chrome-js-ok`
- Current front URL: `data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>`
- Rule: in same-topic replies, the first sentence must lock this current front truth before mentioning any historical page.

## Historical public evidence
- Stronger operable shell: WeChat Channels create page `https://channels.weixin.qq.com/platform/post/create`
- Login-shell evidence: Weibo visitor page `https://login.sina.com.cn/visitor/visitor?...`
- Other public-history evidence: `https://web.wechat.com/`, `https://web.okjike.com/publish`

## Historical failed-shell evidence
- Xiaohongshu failed publish shell: `https://www.xiaohongshu.com/publish/publish`
- Xiaohongshu 404 shell: `https://www.xiaohongshu.com/404?source=/publish/publish`

## Three falsifiable predictions
1. If the user asks again about current front page vs historical pages before giving a newer front-browser truth, my first sentence should lock the current front truth above. Probability: 0.74
2. If I mention historical pages in the same topic, I should keep Channels create and Weibo visitor only as historical evidence, not current front truth. Probability: 0.82
3. If I mention Xiaohongshu publish in the same topic, I should classify it as failed-shell evidence, not operable current page. Probability: 0.88

## Support evidence
- User explicitly gave current front browser truth as Google Chrome `data:` page.
- User explicitly separated browser history as historical evidence, not current page.
- Recent history includes operable-looking and failed-shell pages together, increasing risk of layer confusion.

## Counter-evidence
- The front app can change later, invalidating this card.
- Historical pages sometimes look more actionable than the current `data:` page and can tempt reply drift.

## Falsifier
- A newer front-browser truth appears and shows a different current page.

## Update rule if wrong
- Settle the prediction as miss first, then generate a fresh one-card layered judgment with the newer current front truth before any same-topic analysis.
