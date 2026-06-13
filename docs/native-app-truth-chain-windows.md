# Native App Truth Chain (Windows)

## Goal
Build a stable evidence chain for `native-app` observation on Windows so runtime no longer guesses foreground app state.

## Added primitives
- `inspect_native_apps`: uses PowerShell + `user32.dll` window enumeration to capture foreground window, visible top-level windows, process ids, titles, and evidence markers.
- `focus_native_app`: matches by process name or window title keyword, attempts `SetForegroundWindow`, and returns before/after foreground evidence.
- `nativeAppsShared.ts`: typed snapshot/result payloads shared by both tools.

## Evidence model
Both tools emit:
- `capturedAt`
- structured JSON payload in the final `json=` line
- `evidence=` markers such as `foreground-window`, `visible-window-count=<n>`, `fallback-process-scan`, `matched-window`

## Safety rules
- `inspect_native_apps` is read-only and marked safe.
- `focus_native_app` changes window focus and is therefore treated as high-risk, requiring confirmation via `HighRiskGuard`.
- When UI enumeration fails, the system falls back to process-level snapshots instead of inventing a result.

## Current verifier blocker
In this task run, `execute_command` is still bound to `/bin/sh`, so Windows PowerShell validation could not be executed from the task line. Once the shell adapter is fixed, validate with:
- `npm run typecheck:win`
- `npx vitest run test/executor-tools.test.ts`
