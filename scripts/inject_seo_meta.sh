#!/usr/bin/env bash
# 将 SEO meta 注入 public/index.html 的 <head> 区域（幂等）
set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEX="$REPO_ROOT/public/index.html"
PATCH="$REPO_ROOT/scripts/seo_meta_patch.html"

if [ ! -f "$INDEX" ]; then
  echo "❌ 找不到 $INDEX"
  exit 1
fi

# 幂等：已注入则跳过
if grep -q "og:title" "$INDEX" 2>/dev/null; then
  echo "⏭️ SEO meta 已存在，跳过注入"
  exit 0
fi

# 在 </head> 前插入
sed -i '' "/<\/head>/e cat $PATCH" "$INDEX" 2>/dev/null || \
  sed -i "/<\/head>/r $PATCH" "$INDEX"

echo "✅ SEO meta 已注入 $INDEX"
