#!/bin/bash
# fix-github-pages.sh — 诊断并修复 GitHub Pages 404
# 用法: bash fix-github-pages.sh
# 必须在 wenluDemo 仓库根目录运行

set -e

REPO="fang563094742-svg/wenluDemo"
PAGES_URL="https://fang563094742-svg.github.io/wenluDemo/landing.html"

echo "═══════════════════════════════════════════"
echo "  GitHub Pages 诊断 & 修复"
echo "═══════════════════════════════════════════"
echo ""

# Step 1: 检查当前落地页是否可访问
echo "🔍 Step 1: 检测落地页可达性..."
HTTP_CODE=$(curl -sI -o /dev/null -w '%{http_code}' "$PAGES_URL" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo "   ✅ 落地页已在线 ($PAGES_URL) HTTP $HTTP_CODE"
    echo ""
    echo "🎉 一切正常！落地页可访问。"
    exit 0
fi
echo "   ❌ HTTP $HTTP_CODE — 落地页不可达"
echo ""

# Step 2: 检查 gh CLI
echo "🔍 Step 2: 检测 gh CLI..."
if ! command -v gh &>/dev/null; then
    echo "   ⚠️  gh CLI 未安装"
    echo ""
    echo "   修复方案（选一个）："
    echo "   A) brew install gh && gh auth login"
    echo "   B) 手动到 https://github.com/$REPO/settings/pages 开启 Pages"
    echo ""
    echo "   手动步骤："
    echo "   1. 打开 https://github.com/$REPO/settings/pages"
    echo "   2. Source 选 'GitHub Actions'"
    echo "   3. 保存"
    echo "   4. 推一次代码到 main (改任意 public/ 内文件) 触发 deploy workflow"
    echo ""
    echo "   完成后重新运行本脚本验证。"
    exit 1
fi
echo "   ✅ gh CLI 可用"

# Step 3: 检查认证
echo "🔍 Step 3: 检测 gh 认证状态..."
if ! gh auth status &>/dev/null 2>&1; then
    echo "   ⚠️  gh 未登录"
    echo "   请先运行: gh auth login"
    exit 1
fi
echo "   ✅ gh 已认证"

# Step 4: 检查仓库可见性
echo "🔍 Step 4: 检测仓库..."
VISIBILITY=$(gh repo view "$REPO" --json visibility -q '.visibility' 2>/dev/null || echo "UNKNOWN")
echo "   仓库可见性: $VISIBILITY"
if [ "$VISIBILITY" = "PRIVATE" ]; then
    echo "   ⚠️  Private 仓库需要 Pro/Teams 才能用 Pages"
    echo "   修复方案："
    echo "   A) 把仓库改为 Public: gh repo edit $REPO --visibility public"
    echo "   B) 升级 GitHub 计划"
    echo ""
    read -p "   是否改为 Public? (y/N) " ANSWER
    if [ "$ANSWER" = "y" ] || [ "$ANSWER" = "Y" ]; then
        gh repo edit "$REPO" --visibility public
        echo "   ✅ 已改为 Public"
    else
        echo "   ⏭️  跳过"
    fi
fi

# Step 5: 检查 Pages 是否已启用
echo "🔍 Step 5: 检测 Pages 状态..."
PAGES_STATUS=$(gh api "repos/$REPO/pages" --jq '.status' 2>/dev/null || echo "NOT_ENABLED")
if [ "$PAGES_STATUS" = "NOT_ENABLED" ] || [ -z "$PAGES_STATUS" ]; then
    echo "   ⚠️  GitHub Pages 未启用"
    echo "   正在启用 Pages (source: GitHub Actions)..."
    gh api --method POST "repos/$REPO/pages" \
        -f build_type="workflow" 2>/dev/null && echo "   ✅ Pages 已启用" || {
        echo "   ❌ 自动启用失败"
        echo "   请手动到 https://github.com/$REPO/settings/pages 开启"
        exit 1
    }
else
    echo "   ✅ Pages 状态: $PAGES_STATUS"
fi

# Step 6: 触发 workflow
echo "🔍 Step 6: 触发 deploy workflow..."
gh workflow run deploy.yml --ref main 2>/dev/null || {
    echo "   触发 workflow_dispatch 失败，尝试推空 commit..."
    cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
    git commit --allow-empty -m "chore: trigger pages deploy"
    git push origin main
}
echo "   ✅ Deploy 已触发"

# Step 7: 等待部署
echo ""
echo "⏳ 等待部署（通常1-2分钟）..."
for i in $(seq 1 12); do
    sleep 10
    HTTP_CODE=$(curl -sI -o /dev/null -w '%{http_code}' "$PAGES_URL" 2>/dev/null || echo "000")
    echo "   第${i}次检测: HTTP $HTTP_CODE"
    if [ "$HTTP_CODE" = "200" ]; then
        echo ""
        echo "═══════════════════════════════════════════"
        echo "  🎉 落地页部署成功！"
        echo "  URL: $PAGES_URL"
        echo "═══════════════════════════════════════════"
        exit 0
    fi
done

echo ""
echo "⚠️  2分钟内未检测到上线，可能需要更长时间。"
echo "   请稍后手动访问: $PAGES_URL"
exit 1
