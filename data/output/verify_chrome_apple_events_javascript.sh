#!/bin/sh
set -eu
cat > /tmp/chrome_applescript_verify.applescript <<'EOF'
try
  tell application "Google Chrome"
    activate
    if (count of windows) is 0 then
      make new window
      delay 1
    end if
    tell active tab of front window
      set URL to "data:text/html,<title>codex-chrome-js-ok</title><h1>ok</h1>"
    end tell
    delay 1
    set jsResult to execute active tab of front window javascript "document.title"
    if jsResult is equal to "codex-chrome-js-ok" then
      return "PASS"
    end if
    return "UNEXPECTED|" & jsResult
  end tell
on error errMsg number errNum
  return "ERROR|" & errNum & "|" & errMsg
end try
EOF
result="$(osascript /tmp/chrome_applescript_verify.applescript)"
rm -f /tmp/chrome_applescript_verify.applescript
[ "$result" = "PASS" ]
