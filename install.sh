#!/usr/bin/env bash
set -euo pipefail

# MAE Client Installer
# Installs the mae CLI on any machine with network access to a MAE dashboard.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/King-Capital/multi-agent-engine/main/install.sh | bash
#   # or with options:
#   curl -fsSL ... | bash -s -- --dashboard http://your-host:8400

MAE_DIR="${MAE_DIR:-$HOME/.mae}"
MAE_BIN="${MAE_BIN:-$HOME/.local/bin}"
REPO="https://github.com/King-Capital/multi-agent-engine.git"

info() { echo "  [mae] $*"; }
err()  { echo "  [mae] ERROR: $*" >&2; exit 1; }

# Parse args
DASHBOARD_URL=""
GATEWAY_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dashboard) DASHBOARD_URL="$2"; shift 2 ;;
    --gateway)   GATEWAY_URL="$2"; shift 2 ;;
    *)           shift ;;
  esac
done

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
if [[ -d "$MAE_DIR/engine" ]]; then
  info "Updating existing installation..."
  git -C "$MAE_DIR/engine" pull --ff-only 2>/dev/null || true
else
  info "Cloning MAE..."
  mkdir -p "$MAE_DIR"
  git clone --depth 1 "$REPO" "$MAE_DIR/engine"
fi

# Install deps
info "Installing dependencies..."
cd "$MAE_DIR/engine/engine" && bun install --silent

# Create config if it doesn't exist
if [[ ! -f "$MAE_DIR/config" ]]; then
  info "Creating config at $MAE_DIR/config"
  cat > "$MAE_DIR/config" <<CONF
# MAE Configuration — edit these values for your environment
# This file is sourced by the mae CLI on every invocation.

# Dashboard server URL (required)
MAE_DASHBOARD_URL="${DASHBOARD_URL}"

# LLM gateway URL (required for model discover + AI assist)
MAE_LLM_GATEWAY_URL="${GATEWAY_URL}"
MAE_LLM_GATEWAY_KEY=""

# Default adapter: pi, claude-code, codex, echo
# MAE_DEFAULT_ADAPTER=""

# API auth token (if dashboard requires auth)
# MAE_API_TOKEN=""
CONF

  if [[ -z "$DASHBOARD_URL" ]]; then
    info ""
    info "IMPORTANT: Edit $MAE_DIR/config and set MAE_DASHBOARD_URL"
    info ""
  fi
fi

# Symlink CLI
mkdir -p "$MAE_BIN"
ln -sf "$MAE_DIR/engine/scripts/mae" "$MAE_BIN/mae"
chmod +x "$MAE_BIN/mae"

# Check PATH
if ! echo "$PATH" | grep -q "$MAE_BIN"; then
  info "Add to your shell profile:"
  info "  export PATH=\"$MAE_BIN:\$PATH\""
fi

echo ""
info "Installed! Run: mae version"
echo ""
