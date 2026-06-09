# GitHub branches front-vs-external prediction card

- CapturedAt: 2026-06-09 11:17:20 CST
- Current front browser truth: Google Chrome
- Current front tab title: Branches · fang563094742-svg/wenluDemo
- Current front URL: https://github.com/fang563094742-svg/wenluDemo/branches

## Historical side evidence only
- `https://github.com/fang563094742-svg/wenluDemoWeb/settings/access` is recent-history evidence, not the current front page.
- External direct check for that history URL now returns HTTP 404, so it cannot be promoted to current public availability.

## Single testable prediction
- Object/context: the current Chrome front `wenluDemo/branches` page versus shell-side external reachability for the same URL.
- Prediction: on the next same-theme recheck before the front tab changes, Chrome front truth will still be the `wenluDemo/branches` page, while shell-side direct reachability for that exact URL will remain non-public (`000`, timeout, or another non-200) rather than proving public `200` availability.
- Success condition: repeat shell probe for `https://github.com/fang563094742-svg/wenluDemo/branches` returns non-200, and this card still records the current front page as that branches URL.
- Failure condition: repeat shell probe for the same URL returns HTTP 200 and proves public direct availability, or the front page changes first.
- Confidence: 0.68
- Verify-by: next same-theme recheck before current front tab changes.
- Ready deliverable now: this single card plus an external verify command.
