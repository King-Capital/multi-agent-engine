#!/usr/bin/env bash
set -euo pipefail

# MAE Client Installer
# Installs the mae CLI on any machine with network access to a MAE dashboard.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/King-Capital/multi-agent-engine/main/install.sh | bash
#   # or with options:
#   curl -fsSL ... | bash -s -- --dashboard http://your-host:8400

MAE_DIR="${MAE_HOME:-${MAE_DIR:-$HOME/.mae}}"
MAE_REPO_DIR="${MAE_REPO_DIR:-$MAE_DIR/repo}"
MAE_BIN_DIR="${MAE_BIN_DIR:-${MAE_BIN:-$HOME/.local/bin}}"
REPO="${MAE_GIT_URL:-https://github.com/King-Capital/multi-agent-engine.git}"
MAE_REF="${MAE_REF:-main}"

info() { echo "  [mae] $*"; }
err()  { echo "  [mae] ERROR: $*" >&2; exit 1; }

# Parse args
DASHBOARD_URL=""
GATEWAY_URL=""
A2A_URL="${MAE_A2A_URL:-}"
MAE_A2A_DEFAULT_HOST="${MAE_A2A_DEFAULT_HOST:-}"
MAE_A2A_DEFAULT_PORT="${MAE_A2A_DEFAULT_PORT:-41271}"
LANGFUSE_HOST_VALUE="${LANGFUSE_HOST:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dashboard) DASHBOARD_URL="$2"; shift 2 ;;
    --gateway)   GATEWAY_URL="$2"; shift 2 ;;
    --a2a-url)   A2A_URL="$2"; shift 2 ;;
    --langfuse)  LANGFUSE_HOST_VALUE="$2"; shift 2 ;;
    *)           shift ;;
  esac
done

write_shell_var() {
  local key="$1"
  local value="$2"
  printf '%s=' "$key"
  printf '%q' "$value"
  printf '\n'
}

write_optional_shell_var() {
  local key="$1"
  local value="$2"
  if [[ -n "$value" ]]; then
    write_shell_var "$key" "$value"
  else
    printf '# %s=""\n' "$key"
  fi
}

echo ""
echo "  Multi-Agent Engine — Client Install"
echo "  ────────────────────────────────────"
echo ""

# Check for bun
if ! command -v bun &>/dev/null; then
  info "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
info "Bun $(bun --version)"

# Clone or update
if [[ -d "$MAE_REPO_DIR/.git" ]]; then
  info "Updating existing installation..."
  git -C "$MAE_REPO_DIR" pull --ff-only
else
  info "Cloning MAE..."
  mkdir -p "$MAE_DIR"
  git clone --depth 1 --branch "$MAE_REF" "$REPO" "$MAE_REPO_DIR"
fi

# Install deps
info "Installing dependencies..."
cd "$MAE_REPO_DIR/engine" && bun install --silent

# Create config if it doesn't exist
if [[ ! -f "$MAE_DIR/config" ]]; then
  info "Creating config at $MAE_DIR/config"
  {
    cat <<CONF
# MAE Configuration — edit these values for your environment
# This file is sourced by the mae CLI on every invocation.

# Dashboard server URL (required)
CONF
    write_shell_var MAE_DASHBOARD_URL "$DASHBOARD_URL"
    cat <<CONF

# LLM gateway URL (required for model discover + AI assist)
CONF
    write_shell_var MAE_LLM_GATEWAY_URL "$GATEWAY_URL"
    write_optional_shell_var MAE_LLM_GATEWAY_KEY "${MAE_LLM_GATEWAY_KEY:-}"
    cat <<CONF

# Repo checkout and trace storage
CONF
    write_shell_var MAE_ROOT "$MAE_REPO_DIR"
    write_shell_var MAE_TRACE_DIR "${MAE_TRACE_DIR:-$MAE_DIR/traces}"
    cat <<CONF

# Default adapter: pi, claude-code, codex, echo
CONF
    write_optional_shell_var MAE_DEFAULT_ADAPTER "${MAE_DEFAULT_ADAPTER:-}"
    cat <<CONF

# API auth token (if dashboard requires auth)
# A2A endpoint (if this host has a local or remote A2A service)
CONF
    write_optional_shell_var MAE_API_TOKEN "${MAE_API_TOKEN:-}"
    write_optional_shell_var MAE_A2A_DEFAULT_HOST "$MAE_A2A_DEFAULT_HOST"
    write_optional_shell_var MAE_A2A_DEFAULT_PORT "$MAE_A2A_DEFAULT_PORT"
    write_optional_shell_var MAE_A2A_URL "$A2A_URL"
    write_optional_shell_var MAE_A2A_TOKEN "${MAE_A2A_TOKEN:-}"
    cat <<CONF

# Langfuse observability
CONF
    write_optional_shell_var LANGFUSE_PUBLIC_KEY "${LANGFUSE_PUBLIC_KEY:-}"
    write_optional_shell_var LANGFUSE_SECRET_KEY "${LANGFUSE_SECRET_KEY:-}"
    write_optional_shell_var LANGFUSE_HOST "$LANGFUSE_HOST_VALUE"
  } > "$MAE_DIR/config"

  if [[ -z "$DASHBOARD_URL" ]]; then
    info ""
    info "IMPORTANT: Edit $MAE_DIR/config and set MAE_DASHBOARD_URL"
    info ""
  fi
fi

# Symlink CLI
mkdir -p "$MAE_BIN_DIR"
ln -sf "$MAE_REPO_DIR/scripts/mae" "$MAE_BIN_DIR/mae"
chmod +x "$MAE_BIN_DIR/mae"

# Check PATH
if ! echo "$PATH" | grep -q "$MAE_BIN_DIR"; then
  info "Add to your shell profile:"
  info "  export PATH=\"$MAE_BIN_DIR:\$PATH\""
fi

echo ""
info "Installed! Run: mae version"
echo ""
