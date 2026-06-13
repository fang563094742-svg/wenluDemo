param(
  [string]$OutDir = ".taskline_artifacts\windows_truth"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([System.IO.Path]::IsPathRooted($OutDir)) {
  $targetDir = $OutDir
} else {
  $targetDir = Join-Path $repoRoot $OutDir
}
if (!(Test-Path $targetDir)) {
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WenluForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$capturedAt = [DateTime]::UtcNow.ToString("o")
$foregroundHandle = [WenluForegroundWindow]::GetForegroundWindow()
$windowTitle = ""
$frontPid = $null
$frontProcessName = $null
$frontProcessPath = $null
$frontApp = $null
$frontResponding = $null

if ($foregroundHandle -ne [IntPtr]::Zero) {
  $builder = New-Object System.Text.StringBuilder 2048
  [void][WenluForegroundWindow]::GetWindowText($foregroundHandle, $builder, $builder.Capacity)
  $windowTitle = $builder.ToString()
  [uint32]$pid = 0
  [void][WenluForegroundWindow]::GetWindowThreadProcessId($foregroundHandle, [ref]$pid)
  if ($pid -gt 0) {
    $frontPid = [int]$pid
    try {
      $frontProcess = Get-Process -Id $frontPid -ErrorAction Stop
      $frontProcessName = $frontProcess.ProcessName
      $frontResponding = $frontProcess.Responding
      try { $frontProcessPath = $frontProcess.Path } catch { $frontProcessPath = $null }
      $frontApp = if ($frontProcess.MainWindowTitle) { $frontProcess.MainWindowTitle } elseif ($frontProcess.Description) { $frontProcess.Description } else { $frontProcess.ProcessName }
    } catch {
      $frontApp = $null
    }
  }
}

$runningApps = @()
try {
  $runningApps = Get-Process |
    Where-Object { $_.MainWindowHandle -ne 0 -or $_.MainWindowTitle } |
    Sort-Object ProcessName |
    ForEach-Object {
      [pscustomobject]@{
        processName = $_.ProcessName
        pid = $_.Id
        windowTitle = $_.MainWindowTitle
        responding = $_.Responding
      }
    }
} catch {
  $runningApps = @()
}

$stamp = $capturedAt.Replace(':','-')
$jsonPath = Join-Path $targetDir ("windows_truth_{0}.json" -f $stamp)
$payload = [ordered]@{
  evidenceKind = "windows-native-app-truth"
  capturedAt = $capturedAt
  platform = "win32"
  frontApp = $frontApp
  frontProcessName = $frontProcessName
  frontProcessId = $frontPid
  frontProcessPath = $frontProcessPath
  frontWindowTitle = $windowTitle
  frontResponding = $frontResponding
  foregroundHandle = if ($foregroundHandle -eq [IntPtr]::Zero) { $null } else { [int64]$foregroundHandle }
  runningApps = $runningApps
  evidencePath = $jsonPath
}
$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonPath -Encoding UTF8
$payload | ConvertTo-Json -Depth 6
