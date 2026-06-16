#!/bin/bash
# 检查 GitHub Pages 是否已启用并可访问
# 用法：bash scripts/check_pages_live.sh
# 返回：0=可访问，1=不可访问

URL="https://fang563094742-svg.github.io/wenluDemo/landing.html"
KEYWORD="问路"

echo "🔍 检查落地页: $URL"
HTTP_CODE=$(curl -sS -o /tmp/landing_check.html -w '%{http_code}' "$URL" 2>/dev/null)

if [ "$HTTP_CODE" = "200" ]; then
    if grep -q "$KEYWORD" /tmp/landing_check.html 2>/dev/null; then
        echo "✅ 落地页已上线！HTTP $HTTP_CODE，内容包含关键词'$KEYWORD'"
        echo "📎 链接: $URL"
        # macOS 通知
        osascript -e "display notification \"落地页已上线！$URL\" with title \"问路\" sound name \"Glass\"" 2>/dev/null
        exit 0
    else
        echo "⚠️ HTTP 200 但内容不对（可能是 GitHub 默认 404 页面）"
        exit 1
    fi
else
    echo "❌ HTTP $HTTP_CODE — Pages 尚未启用"
    echo ""
    echo "👉 去这里开启: https://github.com/fang563094742-svg/wenluDemo/settings/pages"
    echo "   Source 选 'GitHub Actions' → Save → 等1-2分钟再跑此脚本"
    exit 1
fi
