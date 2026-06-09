# Google Chrome Apple Events JavaScript 真值卡

- 检查时间: 2026-06-09 08:29:22 +0800
- 检查对象: Google Chrome 的“允许 Apple 事件中的 JavaScript”
- 结论: 已开启

## 证据链

1. `defaults read com.google.Chrome AppleScriptEnabled` 未返回显式偏好项，说明不能仅靠偏好文件下结论。
2. `osascript` 能成功控制 Google Chrome 激活窗口并加载一个 `data:` 页面。
3. 对当前标签页执行 `execute active tab of front window javascript "document.title"` 返回 `codex-chrome-js-ok`。
4. 若该设置未开启，Chrome 会返回权限相关错误，而不会成功执行页内 JavaScript。

## 实测命令

```sh
osascript task_output/chrome_applescript_verify.applescript
```

## 实测结果

```text
OK|codex-chrome-js-ok
```

## 判定标准

- 返回以 `OK|codex-chrome-js-ok` 开头: 视为已开启。
- 返回 `ERROR|...` 且内容指向 JavaScript from Apple Events 未被允许: 视为未开启。
- 返回 `NO_WINDOW` 或其他环境性错误: 视为本次未完成验证，而不直接判定关闭。
