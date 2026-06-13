# Wenlu single-entry gateway supervisor (Windows).
# Keeps the gateway (single public entry) running on port 3210, auto-restart on exit.
# Also starts the LLM broker that per-user brain child processes call.
# Replaces the old "riverMain platform (3210) + gateway (3200)" two-port setup.
#
# Usage (in wenluDemo dir):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-gateway-supervised.ps1
# Stop: Ctrl+C in this window.

$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$logDir = Join-Path $repoRoot ".codex-runtime"
if (!(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Gateway public port (single entry, reuse familiar 3210).
$port = 3210
$env:WENLU_GATEWAY_PORT = "$port"
$lockFile = Join-Path $logDir "gateway-supervisor.lock"

# LLM broker port (per-user brains call it).
$brokerPort = 3260
if ($env:WENLU_BROKER_PORT) { $brokerPort = [int]$env:WENLU_BROKER_PORT }
$script:brokerProc = $null

function Stop-StaleBroker {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*broker/start.ts*' } |
    ForEach-Object { Write-Host "[sup] kill stale broker pid=$($_.ProcessId)" -ForegroundColor DarkYellow; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Test-BrokerHealthy {
  try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$brokerPort/broker/health" -TimeoutSec 2 -ErrorAction Stop; return [bool]$r.ok } catch { return $false }
}
function Start-Broker {
  Stop-StaleBroker
  Write-Host "[sup] start LLM broker (port=$brokerPort)..." -ForegroundColor Cyan
  $tsxCli = Join-Path $repoRoot "node_modules/tsx/dist/cli.mjs"
  $script:brokerProc = Start-Process -FilePath "node" -ArgumentList $tsxCli,"src/broker/start.ts" -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) { if (Test-BrokerHealthy) { Write-Host "[sup] broker ready." -ForegroundColor Green; return $true }; Start-Sleep -Milliseconds 500 }
  Write-Host "[sup] WARN broker not ready in time." -ForegroundColor Red; return $false
}

# Single-instance lock.
if (Test-Path $lockFile) {
  $oldPid = (Get-Content $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($oldPid) {
    $alive = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction SilentlyContinue
    if ($alive -and ($alive.CommandLine -like '*run-gateway-supervised*')) {
      Write-Host "[sup] gateway supervisor already running (pid=$oldPid), exit." -ForegroundColor Yellow; exit 0
    }
  }
}
Set-Content -Path $lockFile -Value $PID

# Kill stale gateway + its orphan brain children (riverMain) + old standalone platform riverMain.
function Stop-StaleGatewayAndChildren {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*gateway/start.ts*' -or $_.CommandLine -like '*riverMain.ts*' } |
    ForEach-Object { Write-Host "[sup] kill stale pid=$($_.ProcessId)" -ForegroundColor DarkYellow; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Wait-PortFree {
  param([int]$Port, [int]$TimeoutSec = 15)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) { if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) { return $true }; Start-Sleep -Milliseconds 500 }
  return $false
}

try {
  Stop-StaleGatewayAndChildren
  Wait-PortFree -Port $port -TimeoutSec 10 | Out-Null
  Start-Broker | Out-Null

  $restart = 0
  while ($true) {
    if (-not (Test-BrokerHealthy)) { Write-Host "[sup] broker down, restarting..." -ForegroundColor Yellow; Start-Broker | Out-Null }
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] start gateway single-entry (port=$port, restart #$restart)..." -ForegroundColor Cyan
    & npx tsx src/gateway/start.ts
    $code = $LASTEXITCODE
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] gateway exited (exit=$code). cleanup and restart..." -ForegroundColor Yellow
    Stop-StaleGatewayAndChildren
    Wait-PortFree -Port $port -TimeoutSec 15 | Out-Null
    $restart++
    Start-Sleep -Seconds 3
  }
}
finally {
  Stop-StaleBroker
  Remove-Item $lockFile -ErrorAction SilentlyContinue
}
