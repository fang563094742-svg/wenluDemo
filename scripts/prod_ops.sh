#!/bin/bash
# 服务器运维一键工具 (本机执行, 自动 ssh 上去做事)
# 用法:
#   ./scripts/prod_ops.sh deploy        # git pull + 重启 brain (常用)
#   ./scripts/prod_ops.sh status        # 看服务状态
#   ./scripts/prod_ops.sh logs          # tail -f brain 日志
#   ./scripts/prod_ops.sh broker-logs   # tail -f broker 日志
#   ./scripts/prod_ops.sh restart       # 重启 brain (不 git pull)
#   ./scripts/prod_ops.sh restart-all   # 重启 broker + brain + nginx
#   ./scripts/prod_ops.sh health        # 探健康
#   ./scripts/prod_ops.sh ssh           # 直接进 ssh
#   ./scripts/prod_ops.sh ledger        # 拉服务器 action-ledger 到本地审计
#   ./scripts/prod_ops.sh psql          # 进服务器 psql

set -uo pipefail

HOST="${WENLU_PROD_HOST:-38.58.56.170}"
USER="${WENLU_PROD_USER:-root}"
# 密码请勿入 git, 经环境变量传:
#   export WENLU_PROD_PASS='xxx'
PASS="${WENLU_PROD_PASS:-}"
PORT="${WENLU_PROD_SSH_PORT:-22}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE="$REPO_ROOT/../.recover_tmp/ssh_probe.expect"
SCP_PROBE="$REPO_ROOT/../.recover_tmp/scp_upload.expect"

if [ -z "$PASS" ]; then
  echo "ERR: 必须先 export WENLU_PROD_PASS='你的服务器密码'"
  exit 2
fi

if [ ! -x "$PROBE" ]; then
  echo "ERR: 找不到 $PROBE (.recover_tmp/ssh_probe.expect 缺失)"
  exit 2
fi

run_remote() {
  "$PROBE" "$HOST" "$USER" "$PASS" "$1"
}

ACTION="${1:-help}"

case "$ACTION" in
  deploy)
    echo "=== git pull + restart brain ==="
    run_remote 'cd /opt/wenlu/wenluDemo && git pull origin main && cd /opt/wenlu/wenluDemoWeb && git pull origin main && cd /opt/wenlu/wenluConnector && git pull origin main && systemctl restart wenlu-brain && sleep 6 && systemctl is-active wenlu-brain && curl -fsS http://127.0.0.1/api/health && echo'
    ;;
  status)
    run_remote 'systemctl status wenlu-broker wenlu-brain nginx postgresql --no-pager 2>&1 | head -60; echo "---"; ss -tlnp | grep -E ":(80|443|3210|3260|5432) "; echo "---"; df -h / | tail -1; echo "---"; uptime'
    ;;
  logs)
    echo "=== brain 日志 (Ctrl+C 退出) ==="
    run_remote 'journalctl -u wenlu-brain -f --no-pager -n 60'
    ;;
  broker-logs)
    run_remote 'journalctl -u wenlu-broker -f --no-pager -n 60'
    ;;
  nginx-logs)
    run_remote 'tail -f /var/log/nginx/access.log'
    ;;
  restart)
    run_remote 'systemctl restart wenlu-brain && sleep 6 && systemctl is-active wenlu-brain && curl -fsS http://127.0.0.1/api/health && echo'
    ;;
  restart-all)
    run_remote 'systemctl restart wenlu-broker && sleep 3 && systemctl restart wenlu-brain && sleep 8 && systemctl restart nginx && sleep 2 && systemctl is-active wenlu-broker wenlu-brain nginx && curl -fsS http://127.0.0.1/api/health && echo'
    ;;
  health)
    echo "本机 127.0.0.1:3210:"
    curl -fsSm 3 http://127.0.0.1:3210/api/health || true; echo
    echo "服务器 38.58.56.170:80:"
    curl -fsSm 5 http://38.58.56.170/api/health || true; echo
    echo "公网 https://api.jiaxinqles.us/api/health (改 DNS 后才通):"
    curl -fsSm 8 https://api.jiaxinqles.us/api/health 2>&1 | head -5; echo
    ;;
  ssh)
    echo "提示: 用密码登录 root@$HOST"
    ssh -p "$PORT" -o StrictHostKeyChecking=no "$USER@$HOST"
    ;;
  ledger)
    echo "拉服务器 action-ledger 到本地 .wenlu-local/server-ledger.ndjson ..."
    run_remote 'cat ~/.wenlu/action-ledger.ndjson 2>/dev/null | wc -l; cat ~/.wenlu/action-ledger.ndjson 2>/dev/null > /tmp/server-ledger.ndjson; wc -c /tmp/server-ledger.ndjson'
    "$SCP_PROBE" "$HOST" "$USER" "$PASS" "$USER@$HOST:/tmp/server-ledger.ndjson" "$REPO_ROOT/.wenlu-local/server-ledger.ndjson" 2>&1 | tail -3
    echo "已下载到: $REPO_ROOT/.wenlu-local/server-ledger.ndjson"
    ;;
  psql)
    echo "进服务器 psql wenlu (密码: Wenlu@Pg2026)..."
    run_remote 'PGPASSWORD=Wenlu@Pg2026 psql -h 127.0.0.1 -U postgres -d wenlu'
    ;;
  help|*)
    cat <<HELP
服务器运维工具. 必须先:
  export WENLU_PROD_PASS='你的服务器密码'

子命令:
  deploy        git pull (三仓库) + 重启 brain  ← 改完代码 push 后跑这个
  restart       仅重启 brain
  restart-all   重启 broker + brain + nginx
  status        看服务/端口/磁盘/uptime
  logs          tail -f brain 日志
  broker-logs   tail -f broker 日志
  nginx-logs    tail -f nginx access.log
  health        本机 + 服务器 + 公网 三处健康检查
  ssh           直接进 ssh
  ledger        把服务器 ledger 拉到本机审计
  psql          进服务器 psql wenlu

例:
  ./scripts/prod_ops.sh status
  ./scripts/prod_ops.sh deploy
  ./scripts/prod_ops.sh logs
HELP
    ;;
esac
