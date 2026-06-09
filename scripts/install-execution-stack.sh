#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STACK_DIR="$ROOT_DIR/tools/execution-stack"
BIN_DIR="$STACK_DIR/bin"
N8N_DIR="$STACK_DIR/n8n"
TASK_VERSION="v3.44.1"
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

verify_stack() {
  echo "Verifying execution stack..."
  "$BIN_DIR/task" --version
  "$N8N_DIR/node_modules/.bin/n8n" --version
}

case "${1:-install}" in
  install)
    install_task
    install_n8n
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
