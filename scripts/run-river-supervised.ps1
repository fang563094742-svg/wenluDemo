# 问路平台守护脚本（Windows）：常驻运行 riverMain，进程异常退出时自动重启。
# 解决「平台进程停了 → 网页/连接器静默失联」的问题。
#
# 用法（在 wenluDemo 目录）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-river-supervised.ps1
# 停止：在本窗口按 Ctrl+C。
#
# 健壮性设计（修复"多守护/孤儿进程同时抢占 3210 → EADDRINUSE 死循环"）：
#   1. 单例锁：同一时间只允许一个守护进程运行，重复启动会直接退出。
#   2. 启动即清场：先杀掉所有残留的 riverMain 进程，确保从干净状态开始。
#   3. 重启前等端口释放：每次重启前确认 3210 已空闲，避免抢占自身遗留进程。

$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$logDir = Join-Path $repoRoot ".codex-runtime"
if (!(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$port = 3210
$lockFile = Join-Path $logDir "river-supervisor.lock"

# --- 单例锁：若已有活着的守护进程，本次直接退出，避免多个守护互相抢端口 ---
if (Test-Path $lockFile) {
  $oldPid = (Get-Content $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($oldPid) {
    $alive = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction SilentlyContinue
    if ($alive -and ($alive.CommandLine -like '*run-river-supervised*')) {
      Write-Host "[守护] 已有守护进程在运行 (pid=$oldPid)，本次退出以避免重复启动。" -ForegroundColor Yellow
      exit 0
    }
  }
  # 锁文件存在但进程已死（陈旧锁），覆盖即可。
}
Set-Content -Path $lockFile -Value $PID

# --- 杀掉所有残留的 riverMain node 进程 ---
function Stop-StaleRiver {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*riverMain.ts*' } |
    ForEach-Object {
      Write-Host "[守护] 清理残留 riverMain 进程 pid=$($_.ProcessId)" -ForegroundColor DarkYellow
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# --- 等待指定端口释放 ---
function Wait-PortFree {
  param([int]$Port, [int]$TimeoutSec = 15)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $busy = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if (-not $busy) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

try {
  # 启动即清场：确保不会和上一轮遗留的孤儿进程抢 3210。
  Stop-StaleRiver
  Wait-PortFree -Port $port -TimeoutSec 10 | Out-Null

  $restart = 0
  while ($true) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] 启动 riverMain（第 $restart 次重启）..." -ForegroundColor Cyan

    # 前台运行：阻塞直到进程退出。npx tsx 直接跑源码。
    & npx tsx src/riverMain.ts

    $code = $LASTEXITCODE
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] riverMain 退出（exit=$code）。清理并准备重启..." -ForegroundColor Yellow

    # 退出后兜底清场：以防 npx 包装层退出但 node 子进程仍残留占端口。
    Stop-StaleRiver
    if (-not (Wait-PortFree -Port $port -TimeoutSec 15)) {
      Write-Host "[守护] 警告：3210 在超时后仍被占用，仍将尝试重启。" -ForegroundColor Red
    }

    $restart++
    Start-Sleep -Seconds 3
  }
}
finally {
  # 正常 Ctrl+C 退出时清掉锁文件（强杀时不会执行，靠启动时的陈旧锁检测兜底）。
  Remove-Item $lockFile -ErrorAction SilentlyContinue
}
