# Safari 3210 三条短期可回证判断清单

生成时间：2026-06-09 08:16 CST
真值法源：`task_output/front-truth-line/latest-safari-3210-single-source.md`
当前前台真值：Safari / 问路 / http://127.0.0.1:3210/

1. 短期判断：只要本轮继续围绕“当前前台页”说话，下一次现场复核时前台应用仍会被读到为 Safari。
   - 回证方式：运行 `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`
   - 命中信号：输出仍为 `Safari`

2. 短期判断：只要未切页，下一次现场复核时前台标签 URL 仍会被读到为 `http://127.0.0.1:3210/`。
   - 回证方式：运行 `osascript -e 'tell application "Safari" to if it is running then get URL of current tab of front window'`
   - 命中信号：输出仍为 `http://127.0.0.1:3210/`

3. 短期判断：后续引用“Safari 3210 真值”时，会继续先落到这张唯一法源卡，而不会把历史公开旁证误当成当前现场。
   - 回证方式：检查 `task_output/front-truth-line/latest-safari-3210-single-source.md`
   - 命中信号：同时存在 `currentTruth.url=http://127.0.0.1:3210/` 与 `historicalPublicCorroboration=` 两行，且二者仍被明确分层。

新的外部可验证任务闭环：
- 目标：确认“3条短期可回证判断清单”已经围绕当前前台 Safari 3210 真值落盘，并可由现场命令与法源卡双重验证。
- 验证命令：`test -f task_output/front-truth-line/safari-3210-short-judgments.md && grep -F '当前前台真值：Safari / 问路 / http://127.0.0.1:3210/' task_output/front-truth-line/safari-3210-short-judgments.md >/dev/null && test "$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true')" = "Safari" && test "$(osascript -e 'tell application "Safari" to if it is running then get URL of current tab of front window')" = "http://127.0.0.1:3210/" && grep -F 'currentTruth.url=http://127.0.0.1:3210/' task_output/front-truth-line/latest-safari-3210-single-source.md >/dev/null`
- 通过信号：退出码 0
