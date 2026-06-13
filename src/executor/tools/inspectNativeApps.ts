/**
 * Windows native-app 真值采集工具。
 *
 * 优先用 PowerShell + Win32 API 读取前台窗口、可见顶层窗口和进程信息；若枚举失败，
 * 退化为进程级快照，但仍留证据，避免靠猜。
 */

import type { Executor_Tool, ToolContext, ToolResult, ToolSpec } from "../types.js";
import type { NativeAppsSnapshot } from "./nativeAppsShared.js";

const INSPECT_NATIVE_APPS_SPEC: ToolSpec = {
  name: "inspect_native_apps",
  description:
    "读取当前 Windows 原生应用现场真值：前台窗口、可见顶层窗口、关联进程、窗口标题与留证信息。",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const WINDOWS_NATIVE_APPS_PS = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WenluNativeAppProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

function Get-WindowTitle([IntPtr]$Handle) {
  $length = [WenluNativeAppProbe]::GetWindowTextLength($Handle)
  $builder = New-Object System.Text.StringBuilder ($length + 1)
  [void][WenluNativeAppProbe]::GetWindowText($Handle, $builder, $builder.Capacity)
  return $builder.ToString()
}

$frontHandle = [WenluNativeAppProbe]::GetForegroundWindow()
$windows = New-Object System.Collections.Generic.List[object]
$evidence = New-Object System.Collections.Generic.List[string]
$processCache = @{}

$callback = [WenluNativeAppProbe+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [WenluNativeAppProbe]::IsWindowVisible($hWnd)) { return $true }
  $title = Get-WindowTitle $hWnd
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }

  [uint32]$pid = 0
  [void][WenluNativeAppProbe]::GetWindowThreadProcessId($hWnd, [ref]$pid)
  if (-not $processCache.ContainsKey($pid)) {
    try { $processCache[$pid] = Get-Process -Id $pid -ErrorAction Stop } catch { $processCache[$pid] = $null }
  }
  $proc = $processCache[$pid]
  $appName = if ($proc) { $proc.ProcessName } else { "pid-$pid" }
  $processPath = $null
  if ($proc) {
    try { $processPath = $proc.Path } catch { $processPath = $null }
  }

  $windows.Add([pscustomobject]@{
    app = $appName
    title = $title
    pid = if ($pid -gt 0) { [int]$pid } else { $null }
    hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
    visible = $true
    focused = ($hWnd -eq $frontHandle)
    processPath = $processPath
  }) | Out-Null
  return $true
}

[void][WenluNativeAppProbe]::EnumWindows($callback, [IntPtr]::Zero)
$front = $windows | Where-Object { $_.focused } | Select-Object -First 1
if ($front) { $evidence.Add("foreground-window") | Out-Null } else { $evidence.Add("foreground-window-missing") | Out-Null }
$evidence.Add("visible-window-count=" + $windows.Count) | Out-Null

if ($windows.Count -eq 0) {
  $fallback = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } |
    Select-Object @{Name='app';Expression={$_.ProcessName}}, @{Name='title';Expression={$_.MainWindowTitle}}, @{Name='pid';Expression={$_.Id}}, @{Name='hwnd';Expression={('0x{0:X}' -f $_.MainWindowHandle)}}, @{Name='visible';Expression={$true}}, @{Name='focused';Expression={$false}}, @{Name='processPath';Expression={$_.Path}}
  $evidence.Add("fallback-process-scan") | Out-Null
  [pscustomobject]@{
    front = $null
    runningApps = @($fallback)
    capturedAt = [DateTime]::UtcNow.ToString("o")
    source = "windows-process-fallback"
    evidence = @($evidence)
  } | ConvertTo-Json -Depth 6 -Compress
} else {
  [pscustomobject]@{
    front = $front
    runningApps = @($windows)
    capturedAt = [DateTime]::UtcNow.ToString("o")
    source = "windows-ui-automation"
    evidence = @($evidence)
  } | ConvertTo-Json -Depth 6 -Compress
}
`;

function summarize(snapshot: NativeAppsSnapshot): string {
  const front = snapshot.front
    ? `${snapshot.front.app} | ${snapshot.front.title} | pid=${snapshot.front.pid ?? "null"}`
    : "front=null";
  const sample = snapshot.runningApps
    .slice(0, 5)
    .map((app) => `${app.app} | ${app.title}`)
    .join("; ");
  return [
    `capturedAt=${snapshot.capturedAt}`,
    `source=${snapshot.source}`,
    `front=${front}`,
    `running=${snapshot.runningApps.length}`,
    sample ? `sample=${sample}` : "sample=none",
    `evidence=${snapshot.evidence.join(",")}`,
    `json=${JSON.stringify(snapshot)}`,
  ].join("\n");
}

export const inspectNativeAppsTool: Executor_Tool = {
  name: "inspect_native_apps",
  spec: INSPECT_NATIVE_APPS_SPEC,
  riskClass: "safe",
  async invoke(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (process.platform !== "win32") {
      return {
        ok: true,
        output: summarize({
          front: null,
          runningApps: [],
          capturedAt: new Date().toISOString(),
          source: "windows-process-fallback",
          evidence: ["unsupported-platform", process.platform],
        }),
      };
    }

    const runCommand = await import("./runCommand.js");
    const runner = runCommand.createRunCommandTool(15000);
    const result = await runner.invoke({ command: WINDOWS_NATIVE_APPS_PS }, ctx);
    if (!result.ok) return result;
    const raw = result.output.trim();
    const lastLine = raw.split(/\r?\n/).filter(Boolean).pop() ?? "";
    try {
      const snapshot = JSON.parse(lastLine) as NativeAppsSnapshot;
      return { ok: true, output: summarize(snapshot) };
    } catch (error) {
      return {
        ok: false,
        output: raw,
        error: `inspect_native_apps 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
