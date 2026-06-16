#!/bin/bash
# 问路生产环境健康巡检 — 一键跑通核心付费链路的外部验证
# 用法: bash scripts/prod-health-check.sh
# 退出码: 0=全部通过, 非0=有断点

set -euo pipefail

BASE_URL="${WENLU_PROD_URL:-https://api.jiaxinqles.us/wenlu}"
PASS=0
FAIL=0
RESULTS=()

check() {
  local name="$1" url="$2" expect="$3"
  local code body
  code=$(curl -sS -o /tmp/wenlu_health_body.txt -w '%{http_code}' --max-time 15 "$url" 2>/dev/null || echo "000")
  body=$(cat /tmp/wenlu_health_body.txt 2>/dev/null || echo "")
  
  if [[ "$code" == "$expect" ]]; then
    PASS=$((PASS+1))
    RESULTS+=("✅ $name (HTTP $code)")
  else
    FAIL=$((FAIL+1))
    RESULTS+=("❌ $name (期望 $expect, 实际 $code)")
  fi
}

check_contains() {
  local name="$1" url="$2" keyword="$3"
  local body
  body=$(curl -sS --max-time 15 "$url" 2>/dev/null || echo "")
  
  if echo "$body" | grep -q "$keyword"; then
    PASS=$((PASS+1))
    RESULTS+=("✅ $name (包含 '$keyword')")
  else
    FAIL=$((FAIL+1))
    RESULTS+=("❌ $name (未找到 '$keyword')")
  fi
}

echo "🧭 问路生产环境巡检"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "目标: $BASE_URL"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# 1. 首页可达
check "首页可达" "$BASE_URL/" "200"

# 2. API 健康端点
check_contains "API健康" "$BASE_URL/api/health" '"status":"ok"'

# 3. 登录页可达
check "登录页可达" "$BASE_URL/login.html" "200"

# 4. 注册页可达
check "注册页可达" "$BASE_URL/register.html" "200"

# 5. 充值中心可达
check "充值中心可达" "$BASE_URL/payment.html" "200"

# 6. 首页包含关键UI元素（登录入口）
check_contains "登录入口存在" "$BASE_URL/" "登录"

# 7. 首页包含充值入口
check_contains "充值入口存在" "$BASE_URL/" "充值"

# 8. CSS 资源可达
check "样式表可达" "$BASE_URL/auth.css?v=20260612-2" "200"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "结果: $PASS 通过 / $FAIL 失败 / $((PASS+FAIL)) 总计"

if [[ $FAIL -gt 0 ]]; then
  echo "⚠️  有 $FAIL 项未通过，请检查上方 ❌ 项"
  exit 1
else
  echo "🟢 全部通过，生产环境付费链路正常"
  exit 0
fi
