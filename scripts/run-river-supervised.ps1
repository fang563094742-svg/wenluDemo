# 问路平台守护脚本（Windows）：常驻运行 riverMain，进程异常退出时自动重启。
# 解决「平台进程停了 → 网页/连接器静默失联」的问题。
#
# 用法（在 wenluDemo 目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-river-supervised.ps1
# 停止：在本窗口按 Ctrl+C。

$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$logDir = Join-Path $repoRoot ".codex-runtime"
if (!(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$restart = 0
while ($true) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "[$ts] 启动 riverMain（第 $restart 次重启）..." -ForegroundColor Cyan

  # 前台运行：阻塞直到进程退出。npx tsx 直接跑源码。
  & npx tsx src/riverMain.ts

  $code = $LASTEXITCODE
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "[$ts] riverMain 退出（exit=$code）。3 秒后自动重启..." -ForegroundColor Yellow
  $restart++
  Start-Sleep -Seconds 3
}
