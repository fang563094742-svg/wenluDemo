$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$runtimeDir = Join-Path $repoRoot ".codex-runtime"
if (!(Test-Path $runtimeDir)) {
  New-Item -ItemType Directory -Path $runtimeDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdoutLog = Join-Path $runtimeDir "resident-$timestamp.stdout.log"
$stderrLog = Join-Path $runtimeDir "resident-$timestamp.stderr.log"

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -like "*riverMain.ts*" -and
    $_.CommandLine -like "*wenluDemo*"
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
  }

$env:NODE_OPTIONS = "--trace-uncaught --unhandled-rejections=strict"

Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList @(
    "-NoProfile",
    "-Command",
    "Set-Location '$repoRoot'; `$env:NODE_OPTIONS='--trace-uncaught --unhandled-rejections=strict'; npx tsx src/riverMain.ts"
  ) `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog | Out-Null

Start-Sleep -Seconds 10

try {
  $health = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:3210/health" -TimeoutSec 8
  Write-Output $health.Content
} catch {
  Write-Error "wenlu service did not become healthy: $($_.Exception.Message)"
  exit 1
}
