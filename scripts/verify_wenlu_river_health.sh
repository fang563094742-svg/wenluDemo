#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
OUTDIR="$ROOT/.taskline_artifacts/wenlu_health_verify"
mkdir -p "$OUTDIR"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG="$OUTDIR/river_${TS}.log"
BODY="$OUTDIR/health_${TS}.json"
ERR="$OUTDIR/health_${TS}.err"
EVIDENCE="$OUTDIR/evidence_${TS}.json"
LATEST="$OUTDIR/latest.json"
STARTED=0
cleanup() {
  if [ "$STARTED" -eq 1 ] && [ "${RIVER_PID:-}" != "" ] && kill -0 "$RIVER_PID" 2>/dev/null; then
    kill "$RIVER_PID" 2>/dev/null || true
    wait "$RIVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM
probe_health() {
  env -u ALL_PROXY -u all_proxy -u http_proxy -u https_proxy curl -fsS http://127.0.0.1:3721/api/health >"$BODY" 2>"$ERR"
}
write_timeout() {
  python3 - "$LOG" "$ERR" "$EVIDENCE" "$LATEST" <<'PY'
import json, sys
log_path, err_path, evidence_path, latest_path = sys.argv[1:5]
evidence = {
    'ok': False,
    'blocker': 'health-check-timeout',
    'log': log_path,
    'curlError': err_path,
}
for path in (evidence_path, latest_path):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(evidence, f, ensure_ascii=False)
raise SystemExit(1)
PY
}
if ! probe_health; then
  (
    cd "$ROOT"
    npm run river
  ) >"$LOG" 2>&1 &
  RIVER_PID=$!
  STARTED=1
  OK=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24; do
    if probe_health; then
      OK=1
      break
    fi
    sleep 1
  done
  if [ "$OK" -ne 1 ]; then
    write_timeout
  fi
else
  : >"$LOG"
fi
python3 - "$BODY" "$LOG" "$ERR" "$EVIDENCE" "$LATEST" "$STARTED" <<'PY'
import json, sys
body_path, log_path, err_path, evidence_path, latest_path, started = sys.argv[1:7]
with open(body_path, 'r', encoding='utf-8') as f:
    data = json.load(f)
service = data.get('service')
ok = data.get('status') == 'ok' and service in {'wenlu-api', 'wenlu-demo-app'}
evidence = {
    'ok': ok,
    'observed': data,
    'expectedStatus': 'ok',
    'acceptedServices': ['wenlu-api', 'wenlu-demo-app'],
    'log': log_path,
    'body': body_path,
    'curlError': err_path,
    'startedNewRiver': started == '1',
}
if not ok:
    evidence['blocker'] = 'unexpected-health-payload'
for path in (evidence_path, latest_path):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(evidence, f, ensure_ascii=False)
raise SystemExit(0 if ok else 1)
PY
