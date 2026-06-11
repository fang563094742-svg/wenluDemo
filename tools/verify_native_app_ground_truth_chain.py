#!/usr/bin/env python3
import glob
import json
import os
import subprocess
import sys

root = os.getcwd()
subprocess.run(["bash", "tools/native_app_capture_and_record.sh"], check=True, cwd=root, stdout=subprocess.DEVNULL)
latest = max(glob.glob(os.path.join(root, "native_app_probe/evidence/native_app_truth_*.json")), key=os.path.getmtime)
with open(latest, 'r', encoding='utf-8') as f:
    data = json.load(f)
required = ["frontApp", "windowTitle", "runningApps", "capturedAt", "screenCapture", "evidenceKind"]
missing = [k for k in required if k not in data]
if missing:
    print(f"missing keys: {missing}")
    sys.exit(1)
if not isinstance(data['runningApps'], list):
    print('runningApps not list')
    sys.exit(1)
if data['screenCapture'] and not os.path.exists(data['screenCapture']):
    print('missing screenshot file')
    sys.exit(1)
if data['evidenceKind'] != 'native-app-truth':
    print('wrong evidenceKind')
    sys.exit(1)
print(json.dumps({"ok": True, "latest": latest, "frontApp": data['frontApp'], "windowTitle": data['windowTitle']}, ensure_ascii=False))
