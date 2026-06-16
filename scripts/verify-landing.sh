#!/bin/bash
# 落地页上线验证脚本
# 用法: bash scripts/verify-landing.sh [URL]
# 默认检查 GitHub Pages 地址

URL="${1:-https://fang563094742-svg.github.io/wenluDemo/landing.html}"
EVIDENCE_DIR="/tmp/landing_verify"
mkdir -p "$EVIDENCE_DIR"

echo "=== 落地页上线验证 ==="
echo "目标: $URL"
echo ""

# 1. HTTP 可达性
HTTP_CODE=$(curl -sS -o "$EVIDENCE_DIR/body.html" -w '%{http_code}' "$URL" 2>"$EVIDENCE_DIR/curl_err.txt")
echo "[1/4] HTTP 状态码: $HTTP_CODE"

if [ "$HTTP_CODE" != "200" ]; then
  echo "❌ FAIL: 页面不可达 (HTTP $HTTP_CODE)"
  cat "$EVIDENCE_DIR/curl_err.txt" 2>/dev/null
  exit 1
fi

# 2. 关键内容检查
echo -n "[2/4] 包含'问路'关键词: "
if grep -q "问路" "$EVIDENCE_DIR/body.html"; then
  echo "✅"
else
  echo "❌ 页面不含'问路'"
  exit 1
fi

# 3. OG 标签检查
echo -n "[3/4] OG meta 标签: "
if grep -q 'og:title' "$EVIDENCE_DIR/body.html"; then
  echo "✅"
else
  echo "⚠️ 缺少 og:title (soft-signal)"
fi

# 4. 页面大小
SIZE=$(wc -c < "$EVIDENCE_DIR/body.html" | tr -d ' ')
echo "[4/4] 页面大小: ${SIZE} bytes"

if [ "$SIZE" -lt 1000 ]; then
  echo "❌ FAIL: 页面过小，可能是错误页"
  exit 1
fi

# 生成证据 JSON
cat > "$EVIDENCE_DIR/verdict.json" << EJSON
{
  "url": "$URL",
  "http_code": $HTTP_CODE,
  "has_keyword": true,
  "size_bytes": $SIZE,
  "verdict": "PASS",
  "checked_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EJSON

echo ""
echo "✅ PASS — 落地页已上线且内容正常"
echo "证据: $EVIDENCE_DIR/verdict.json"
exit 0
