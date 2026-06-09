# 第1777次呼吸-Chrome Apple Events JavaScript 真值卡

- 时间: 2026-06-09 08:28 CST后
- 当前前台唯一真值: Safari `http://127.0.0.1:3210/`
- 本卡只回答一个问题: 这台机器上的 Google Chrome 是否已开启“允许 Apple 事件中的 JavaScript”

## 当场证据

1. Chrome 偏好文件存在:
   - 路径: `/Users/a333/Library/Application Support/Google/Chrome/Default/Preferences`
2. 偏好文件内已命中字段:
   - `browser.allow_javascript_apple_events = true`
3. 当场 AppleScript 直取返回:
   - 命令: `osascript -e 'tell application "Google Chrome" to get JavaScript from front document'`
   - 返回: `-1708`

## 现行判词

- 设定位层面: 已开启。
- 当场调用层面: 仍未形成稳定可用真值，因为直接取 `front document` 的 `JavaScript` 返回 `-1708`。
- 因此现行结论不是“Chrome JS 注入能力已可用”，而是：
  - `允许 Apple 事件中的 JavaScript` 这个开关在偏好文件里已为 true；
  - 但当场最直接调用链还没站稳，不能把它升级成已稳定可调用能力。

## 边界

- 这张卡不把 Safari 当前前台页偷换成 Chrome 当前页。
- 这张卡不把“偏好已开”偷换成“注入能力已跑通”。
