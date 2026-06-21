#!/bin/sh
# ============================================================
# verify_evidence_chain.sh — 通用验收证据链验证器
# 
# 用法:
#   sh verify_evidence_chain.sh --self-test          # 自检模式
#   sh verify_evidence_chain.sh --check-file <path>  # 验证文件存在
#   sh verify_evidence_chain.sh --check-port <port>  # 验证端口监听
#   sh verify_evidence_chain.sh --check-cmd <cmd>    # 验证命令成功
#   sh verify_evidence_chain.sh --check-content <file> <pattern>  # 验证文件含内容
#   sh verify_evidence_chain.sh --full <manifest>    # 完整三层验证
#
# 三层验证框架:
#   L1 执行证据: 动作确实被执行（文件被创建/修改/命令有输出）
#   L2 状态证据: 结果确实生效（服务响应/文件含预期内容/测试通过）
#   L3 回归证据: 未引入破坏（无新报错/既有测试不红）
#
# 退出码: 0=全部通过  1=有hard-gate失败  2=仅soft-signal警告
# ============================================================

set -e

PASS=0
FAIL=0
WARN=0
RESULTS=""

# 颜色（如果终端支持）
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  NC='\033[0m'
else
  GREEN='' RED='' YELLOW='' NC=''
fi

log_pass() {
  PASS=$((PASS + 1))
  RESULTS="${RESULTS}\n${GREEN}✓${NC} $1"
  printf "${GREEN}✓${NC} %s\n" "$1"
}

log_fail() {
  FAIL=$((FAIL + 1))
  RESULTS="${RESULTS}\n${RED}✗${NC} $1"
  printf "${RED}✗${NC} %s\n" "$1"
}

log_warn() {
  WARN=$((WARN + 1))
  RESULTS="${RESULTS}\n${YELLOW}△${NC} $1"
  printf "${YELLOW}△${NC} %s\n" "$1"
}

# --- L1: 执行证据验证 ---
check_file_exists() {
  if [ -f "$1" ]; then
    log_pass "L1-FILE: $1 exists ($(wc -c < "$1") bytes)"
  else
    log_fail "L1-FILE: $1 NOT found"
  fi
}

check_file_modified_recently() {
  # $1=file $2=minutes (default 10)
  mins=${2:-10}
  if [ -f "$1" ]; then
    # macOS stat
    mtime=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null)
    now=$(date +%s)
    diff=$(( now - mtime ))
    threshold=$(( mins * 60 ))
    if [ "$diff" -lt "$threshold" ]; then
      log_pass "L1-FRESH: $1 modified ${diff}s ago (< ${threshold}s)"
    else
      log_warn "L1-STALE: $1 last modified ${diff}s ago (> ${threshold}s threshold)"
    fi
  else
    log_fail "L1-FRESH: $1 does not exist"
  fi
}

# --- L2: 状态证据验证 ---
check_port_listening() {
  if lsof -iTCP:"$1" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    log_pass "L2-PORT: port $1 is listening"
  else
    log_fail "L2-PORT: port $1 is NOT listening"
  fi
}

check_cmd_succeeds() {
  if eval "$@" >/dev/null 2>&1; then
    log_pass "L2-CMD: '$*' succeeded"
  else
    log_fail "L2-CMD: '$*' failed"
  fi
}

check_file_contains() {
  if grep -q "$2" "$1" 2>/dev/null; then
    log_pass "L2-CONTENT: $1 contains pattern '$2'"
  else
    log_fail "L2-CONTENT: $1 does NOT contain pattern '$2'"
  fi
}

check_http_200() {
  code=$(curl -s -o /dev/null -w "%{http_code}" "$1" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    log_pass "L2-HTTP: $1 returned 200"
  else
    log_fail "L2-HTTP: $1 returned $code (expected 200)"
  fi
}

# --- L3: 回归证据验证 ---
check_no_errors_in_log() {
  if [ -f "$1" ]; then
    errors=$(grep -ci 'error\|exception\|fatal\|panic' "$1" 2>/dev/null || echo 0)
    if [ "$errors" -eq 0 ]; then
      log_pass "L3-LOG: $1 has no error/exception/fatal lines"
    else
      log_warn "L3-LOG: $1 has $errors error-like lines"
    fi
  else
    log_warn "L3-LOG: $1 not found, skipping"
  fi
}

check_tests_pass() {
  if eval "$@" >/dev/null 2>&1; then
    log_pass "L3-TEST: '$*' all green"
  else
    log_fail "L3-TEST: '$*' has failures"
  fi
}

# --- 清单模式（从manifest文件读取验证步骤） ---
run_manifest() {
  if [ ! -f "$1" ]; then
    log_fail "MANIFEST: $1 not found"
    return
  fi
  while IFS='|' read -r layer check args; do
    # 跳过注释和空行
    case "$layer" in \#*|"") continue ;; esac
    case "$check" in
      file_exists)       check_file_exists "$args" ;;
      file_fresh)        check_file_modified_recently $args ;;
      port)              check_port_listening "$args" ;;
      cmd)               check_cmd_succeeds $args ;;
      content)           check_file_contains $args ;;
      http)              check_http_200 "$args" ;;
      no_errors)         check_no_errors_in_log "$args" ;;
      test)              check_tests_pass $args ;;
      *)                 log_warn "UNKNOWN CHECK: $check" ;;
    esac
  done < "$1"
}

# --- 自检模式 ---
self_test() {
  echo "=== verify_evidence_chain.sh 自检 ==="
  echo ""
  echo "--- L1 执行证据 ---"
  check_file_exists "$0"
  check_file_modified_recently "$0" 60
  echo ""
  echo "--- L2 状态证据 ---"
  check_cmd_succeeds "true"
  check_file_contains "$0" "三层验证"
  echo ""
  echo "--- L3 回归证据 ---"
  check_cmd_succeeds "sh -n $0"
  echo ""
  echo "=== 汇总 ==="
  echo "通过: $PASS  失败: $FAIL  警告: $WARN"
  if [ "$FAIL" -gt 0 ]; then
    exit 1
  elif [ "$WARN" -gt 0 ]; then
    exit 2
  else
    exit 0
  fi
}

# --- 主入口 ---
case "${1:-}" in
  --self-test)
    self_test
    ;;
  --check-file)
    check_file_exists "$2"
    ;;
  --check-port)
    check_port_listening "$2"
    ;;
  --check-cmd)
    shift
    check_cmd_succeeds "$@"
    ;;
  --check-content)
    check_file_contains "$2" "$3"
    ;;
  --check-http)
    check_http_200 "$2"
    ;;
  --full)
    run_manifest "$2"
    ;;
  *)
    echo "用法: $0 --self-test | --check-file <path> | --check-port <port> | --check-cmd <cmd> | --check-content <file> <pattern> | --check-http <url> | --full <manifest>"
    exit 1
    ;;
esac

# 最终退出码
if [ "$FAIL" -gt 0 ]; then
  exit 1
elif [ "$WARN" -gt 0 ]; then
  exit 2
else
  exit 0
fi
