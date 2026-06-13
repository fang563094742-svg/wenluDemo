export interface NativeAppWindowInfo {
  app: string;
  title: string;
  pid: number | null;
  hwnd: string | null;
  visible: boolean;
  focused: boolean;
  processPath: string | null;
}

export interface NativeAppsSnapshot {
  front: NativeAppWindowInfo | null;
  runningApps: NativeAppWindowInfo[];
  capturedAt: string;
  source: "windows-ui-automation" | "windows-process-fallback";
  evidence: string[];
}

export interface NativeAppFocusResult {
  app: string;
  matched: boolean;
  beforeFront: NativeAppWindowInfo | null;
  afterFront: NativeAppWindowInfo | null;
  switched: boolean;
  evidence: string[];
  capturedAt: string;
}
