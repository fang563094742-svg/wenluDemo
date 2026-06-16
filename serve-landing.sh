#!/bin/bash
# 一键启动本地落地页预览 (macOS)
# 用法: bash serve-landing.sh [port]
PORT=${1:-8888}
DIR="$(cd "$(dirname "$0")/public" && pwd)"

# Kill existing on same port
lsof -ti:$PORT 2>/dev/null | xargs kill 2>/dev/null

echo "🚀 落地页预览启动: http://localhost:$PORT/landing.html"
echo "   目录: $DIR"
echo "   Ctrl+C 停止"
cd "$DIR" && python3 -m http.server $PORT
