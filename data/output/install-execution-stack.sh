#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STACK_DIR="$ROOT_DIR/tools/execution-stack"
BIN_DIR="$STACK_DIR/bin"
N8N_DIR="$STACK_DIR/n8n"
TASK_VERSION="v3.44.1"
CLAUDE_CODE_VERSION="2.1.168"
CODEX_VERSION="0.137.0"
MCP_INSPECTOR_VERSION="0.22.0"
ZX_VERSION="8.8.5"
ARCH_RAW="$(uname -m)"
OS_RAW="$(uname -s)"

case "$ARCH_RAW" in
  arm64|aarch64) TASK_ARCH="arm64" ;;
  x86_64|amd64) TASK_ARCH="amd64" ;;
  *) echo "Unsupported arch: $ARCH_RAW" >&2; exit 1 ;;
esac

case "$OS_RAW" in
  Darwin) TASK_OS="darwin" ;;
  Linux) TASK_OS="linux" ;;
  *) echo "Unsupported OS: $OS_RAW" >&2; exit 1 ;;
esac

mkdir -p "$BIN_DIR" "$N8N_DIR"

install_task() {
  local archive="task_${TASK_OS}_${TASK_ARCH}.tar.gz"
  local url="https://github.com/go-task/task/releases/download/${TASK_VERSION}/${archive}"
  echo "Installing Task ${TASK_VERSION}..."
  curl -L --fail --retry 2 -o "$STACK_DIR/$archive" "$url"
  tar -xzf "$STACK_DIR/$archive" -C "$BIN_DIR" task
  chmod +x "$BIN_DIR/task"
  "$BIN_DIR/task" --version
}

install_n8n() {
  echo "Installing n8n locally..."
  npm install --prefix "$N8N_DIR" n8n
  "$N8N_DIR/node_modules/.bin/n8n" --version
}

install_global_cli_tools() {
  echo "Installing CLI/control tools locally via npm..."
  npm install --prefix "$STACK_DIR" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "@modelcontextprotocol/inspector@${MCP_INSPECTOR_VERSION}" \
    "zx@${ZX_VERSION}"
}

verify_cmd() {
  local label="$1"
  shift
  echo "Verifying ${label}..."
  "$@"
}

verify_stack() {
  echo "Verifying execution stack..."
  verify_cmd "task" "$BIN_DIR/task" --version
  verify_cmd "n8n" "$N8N_DIR/node_modules/.bin/n8n" --version
  verify_cmd "claude-code" "$STACK_DIR/node_modules/.bin/claude" --version
  verify_cmd "codex" "$STACK_DIR/node_modules/.bin/codex" --version
  verify_cmd "mcp-inspector" "$STACK_DIR/node_modules/.bin/mcp-inspector" --version
  verify_cmd "zx" "$STACK_DIR/node_modules/.bin/zx" --version
}

case "${1:-install}" in
  install)
    install_task
    install_n8n
    install_global_cli_tools
    verify_stack
    ;;
  verify)
    verify_stack
    ;;
  *)
    echo "Usage: $0 [install|verify]" >&2
    exit 1
    ;;
esac
