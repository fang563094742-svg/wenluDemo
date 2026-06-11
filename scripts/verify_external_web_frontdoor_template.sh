#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/.taskline_artifacts/browser_frontdoor_template_verify}"
mkdir -p "$OUT_DIR"

VERIFY_SCRIPT="$ROOT/scripts/verify_browser_frontdoor_chain.sh"
TEMPLATE_FILE="$ROOT/EXTERNAL_WEB_FRONTDOOR_TEMPLATE.md"
CARD_FILE="$ROOT/EXTERNAL_WEB_FRONTDOOR_CARD.md"
SUMMARY_FILE="$OUT_DIR/template_verify_summary.json"

[ -f "$TEMPLATE_FILE" ]
[ -f "$CARD_FILE" ]
[ -x "$VERIFY_SCRIPT" ] || chmod +x "$VERIFY_SCRIPT"

set +e
"$VERIFY_SCRIPT" "$OUT_DIR" >/tmp/browser_frontdoor_template_verify.stdout 2>/tmp/browser_frontdoor_template_verify.stderr
RC=$?
set -e

LATEST_SUMMARY="$OUT_DIR/latest_browser_frontdoor_summary.json"
LATEST_TRUTH="$OUT_DIR/latest_browser_front_truth.json"
[ -f "$LATEST_SUMMARY" ]
[ -f "$LATEST_TRUTH" ]

export TEMPLATE_FILE CARD_FILE LATEST_SUMMARY LATEST_TRUTH SUMMARY_FILE RC
python3 - <<'PY'
import json, os
from pathlib import Path

template = Path(os.environ['TEMPLATE_FILE']).read_text(encoding='utf-8')
card = Path(os.environ['CARD_FILE']).read_text(encoding='utf-8')
summary = json.loads(Path(os.environ['LATEST_SUMMARY']).read_text(encoding='utf-8'))
truth = json.loads(Path(os.environ['LATEST_TRUTH']).read_text(encoding='utf-8'))
required_sections = ["适用边界", "操作步骤", "验收标准", "对照说明"]
missing = [sec for sec in required_sections if sec not in template]
allowed_blockers = {"safari-not-front", "gmail-front-not-github-access", "safari-front-unexpected-page"}
card_has_route = all(token in card for token in ["GitHub", "Gmail", "access", "verification"])
payload = {
    "ok": not missing and card_has_route and bool(summary.get("truthJsonFile")) and summary.get("verdict") == "blocked" and summary.get("blocker") in allowed_blockers,
    "templateSectionsPresent": sorted(set(required_sections) - set(missing)),
    "missingSections": missing,
    "cardHasConcreteRoute": card_has_route,
    "summary": summary,
    "truth": truth,
    "expectedVerifierExit": int(os.environ['RC']),
    "verifierPassedAsBlockedSample": int(os.environ['RC']) != 0 and summary.get("verdict") == "blocked"
}
Path(os.environ['SUMMARY_FILE']).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding='utf-8')
print(json.dumps(payload, ensure_ascii=False))
if payload["ok"]:
    raise SystemExit(0)
raise SystemExit(1)
PY
