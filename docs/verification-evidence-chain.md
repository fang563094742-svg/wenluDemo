# 验证证据链规范

目标：把“完成/失败”的判断沉淀为可复跑、可留档、可客观检查的证据链，避免“做了但证明不了”。

## 统一原语
- 入口：`tsx scripts/verifyWithEvidence.ts <name> <verifyCmd> [outDir]`
- 产物：同名时间戳的 `stdout.txt`、`stderr.txt`、`json` 三件套
- 判定：以 `verifyCmd` 退出码为硬门；0 表示通过，非 0 表示失败
- 留证：JSON 记录命令、退出码、时间戳、输出预览、证据文件路径

## 证据链要求
1. 每个任务必须先定义一个可以客观执行的 `verifyCmd`。
2. `verifyCmd` 必须只依赖当前环境真实状态，不依赖口头描述。
3. 验证产物必须可回看，至少包含 stdout/stderr/json。
4. 若验证依赖平台差异，优先用 Node/PowerShell 等本机可用运行时，不再只依赖 bash。
5. 同一类任务复跑时，优先直接复用该原语，而不是重新手写零散验证脚本。

## Windows 示例
- 成功样例：`npx tsx scripts/verifyWithEvidence.ts echo_ok "powershell -NoProfile -Command \"Write-Output ok\""`
- 失败样例：`npx tsx scripts/verifyWithEvidence.ts missing_file "powershell -NoProfile -Command \"Get-Item missing.txt\""`

## 收口标准
满足以下三点才算“可验证”：
- 有明确的 `verifyCmd`
- 有真实退出码结果
- 有已落盘的证据文件可供回查
