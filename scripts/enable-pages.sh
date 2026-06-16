#!/bin/bash
# 一键启用 GitHub Pages（需要先安装 gh CLI 并登录）
# 用法: bash scripts/enable-pages.sh

set -e

REPO="fang563094742-svg/wenluDemo"

echo "=== 启用 GitHub Pages (source: GitHub Actions) ==="

# 检查 gh 是否可用
if ! command -v gh &>/dev/null; then
  echo "❌ gh CLI 未安装。安装: brew install gh"
  echo ""
  echo "=== 手动启用步骤（30秒） ==="
  echo "1. 打开 https://github.com/$REPO/settings/pages"
  echo "2. Source 选 'GitHub Actions'"
  echo "3. 保存"
  echo "4. 回到仓库，Actions 标签页 → 手动触发 'Deploy to GitHub Pages'"
  echo "5. 等 30s → 访问 https://fang563094742-svg.github.io/wenluDemo/landing.html"
  exit 1
fi

# 用 gh api 启用 pages
gh api -X POST "/repos/$REPO/pages" \
  -f build_type=workflow \
  --silent && echo "✅ Pages 已启用 (source: workflow)" || echo "⚠️ Pages 可能已启用，继续..."

# 触发 workflow
echo "=== 触发部署 workflow ==="
gh workflow run "Deploy to GitHub Pages" -R "$REPO" && echo "✅ 部署已触发" || {
  echo "⚠️ workflow 触发失败，尝试 push 触发..."
  cd "$(dirname "$0")/.."
  git commit --allow-empty -m "chore: trigger pages deploy" && git push origin main
}

echo ""
echo "=== 等待 60s 后验证 ==="
sleep 60
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "https://fang563094742-svg.github.io/wenluDemo/landing.html")
if [ "$STATUS" = "200" ]; then
  echo "✅ 落地页已上线: https://fang563094742-svg.github.io/wenluDemo/landing.html"
else
  echo "⚠️ HTTP $STATUS — 可能还在部署中，等几分钟再访问"
  echo "   https://fang563094742-svg.github.io/wenluDemo/landing.html"
fi
