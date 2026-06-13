/**
 * Windows native-app 聚焦工具。
 */

import type { Executor_Tool, ToolContext, ToolResult, ToolSpec } from "../types.js";
import type { NativeAppFocusResult } from "./nativeAppsShared.js";

const FOCUS_NATIVE_APP_SPEC: ToolSpec = {
  name: "focus_native_app",
  description: "将指定 Windows 原生应用窗口切到前台，并返回切换前后真值证据。",
  parameters: {
    type: "object",
    properties: {
      app: { type: "string", description: "应用名或窗口标题关键字，例如 Chess、Chrome、Safari。" },
    },
    required: ["app"],
    additionalProperties: false,
  },
};

const FOCUS_NATIVE_APP_PS = String.raw`
param([string]$Target)
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WenluNativeAppFocus {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

function Get-WindowTitle([IntPtr]$Handle) {
  $length = [WenluNativeAppFocus]::GetWindowTextLength($Handle)
  $builder = New-Object System.Text.StringBuilder ($length + 1)
  [void][WenluNativeAppFocus]::GetWindowText($Handle, $builder, $builder.Capacity)
  return $builder.ToString()
}

function Snapshot($frontHandle) {
  $windows = New-Object System.Collections.Generic.List[object]
  $callback = [WenluNativeAppFocus+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [WenluNativeAppFocus]::IsWindowVisible($hWnd)) { return $true }
    $title = Get-WindowTitle $hWnd
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }
    [uint32]$pid = 0
    [void][WenluNativeAppFocus]::GetWindowThreadProcessId($hWnd, [ref]$pid)
    $proc = $null
    try { $proc = Get-Process -Id $pid -ErrorAction Stop } catch {}
    $windows.Add([pscustomobject]@{
      app = if ($proc) { $proc.ProcessName } else { "pid-$pid" }
      title = $title
      pid = if ($pid -gt 0) { [int]$pid } else { $null }
      hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
      visible = $true
      focused = ($hWnd -eq $frontHandle)
      processPath = if ($proc) { try { $proc.Path } catch { $null } } else { $null }
    }) | Out-Null
    return $true
  }
  [void][WenluNativeAppFocus]::EnumWindows($callback, [IntPtr]::Zero)
  $front = $windows | Where-Object { $_.focused } | Select-Object -First 1
  return [pscustomobject]@{ front = $front; runningApps = @($windows) }
}

$beforeHandle = [WenluNativeAppFocus]::GetForegroundWindow()
$before = Snapshot $beforeHandle
$match = $before.runningApps | Where-Object { $_.app -like "*$Target*" -or $_.title -like "*$Target*" } | Select-Object -First 1
$evidence = New-Object System.Collections.Generic.List[string]
$switched = $false
if ($match) {
  $handle = [IntPtr]([Convert]::ToInt64($match.hwnd, 16))
  [void][WenluNativeAppFocus]::ShowWindowAsync($handle, 5)
  Start-Sleep -Milliseconds 150
  $switched = [WenluNativeAppFocus]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 200
  $evidence.Add("matched-window") | Out-Null
  $evidence.Add("set-foreground-attempted") | Out-Null
} else {
  $evidence.Add("match-missing") | Out-Null
}
$after = Snapshot ([WenluNativeAppFocus]::GetForegroundWindow())
[pscustomobject]@{
  app = $Target
  matched = [bool]$match
  beforeFront = $before.front
  afterFront = $after.front
  switched = [bool]$switched
  evidence = @($evidence)
  capturedAt = [DateTime]::UtcNow.ToString("o")
} | ConvertTo-Json -Depth 6 -Compress
`;

function summarize(result: NativeAppFocusResult): string {
  return [
    `app=${result.app}`,
    `matched=${result.matched}`,
    `switched=${result.switched}`,
    `before=${result.beforeFront ? `${result.beforeFront.app} | ${result.beforeFront.title}` : "null"}`,
    `after=${result.afterFront ? `${result.afterFront.app} | ${result.afterFront.title}` : "null"}`,
    `evidence=${result.evidence.join(",")}`,
    `json=${JSON.stringify(result)}`,
  ].join("\n");
}

export const focusNativeAppTool: Executor_Tool = {
  name: "focus_native_app",
  spec: FOCUS_NATIVE_APP_SPEC,
  riskClass: "conditional",
  async invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const app = typeof args.app === "string" ? args.app.trim() : "";
    if (!app) {
      return { ok: false, output: "", error: "focus_native_app 缺少有效的 app 参数" };
    }
    if (process.platform !== "win32") {
      return { ok: false, output: "", error: `focus_native_app 仅支持 Windows，当前为 ${process.platform}` };
    }

    const runCommand = await import("./runCommand.js");
    const escaped = app.replace(/'/g, "''");
    const runner = runCommand.createRunCommandTool(15000);
    const result = await runner.invoke({ command: `${FOCUS_NATIVE_APP_PS} -Target '${escaped}'` }, ctx);
    if (!result.ok) return result;
    const raw = result.output.trim();
    const lastLine = raw.split(/\r?\n/).filter(Boolean).pop() ?? "";
    try {
      const parsed = JSON.parse(lastLine) as NativeAppFocusResult;
      return { ok: true, output: summarize(parsed) };
    } catch (error) {
      return {
        ok: false,
        output: raw,
        error: `focus_native_app 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
