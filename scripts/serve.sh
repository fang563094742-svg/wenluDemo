#!/bin/sh
# 本机检阅启动脚本：从 .env 加载 GPT-5.4 配置到环境变量，再以 npm start 拉起 Web 服务。
# 正式入口 src/index.ts 只从环境变量读 key（不自读 .env），故用本脚本注入。不回显 key 值。
set -e
cd "$(dirname "$0")/.."
set -a
. ./.env
set +a
exec npm start
