#!/usr/bin/env bash
set -euo pipefail

# MAE Dev Sandbox Provisioner
# Run on a fresh Debian 12/13 LXC to set up a fully warmed dev environment

echo "=== MAE Dev Sandbox Provisioner ==="
export DEBIAN_FRONTEND=noninteractive

# System basics
apt-get update -qq
apt-get install -y -qq curl wget git sudo build-essential ca-certificates gnupg lsb-release jq unzip openssh-client tmux htop

# Node.js 24.x
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -qq nodejs
fi
echo "Node: $(node --version)"

# Bun
if ! command -v bun &>/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  ln -sf ~/.bun/bin/bun /usr/local/bin/bun
  ln -sf ~/.bun/bin/bunx /usr/local/bin/bunx
fi
echo "Bun: $(bun --version)"

# Go
if ! command -v go &>/dev/null; then
  GO_VER="1.24.3"
  wget -q "https://go.dev/dl/go${GO_VER}.linux-amd64.tar.gz" -O /tmp/go.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm /tmp/go.tar.gz
  echo 'export PATH=$PATH:/usr/local/go/bin:~/go/bin' >> /etc/profile.d/go.sh
  export PATH=$PATH:/usr/local/go/bin
fi
echo "Go: $(go version)"

# GitHub CLI
if ! command -v gh &>/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
  apt-get install -y -qq gh
fi
echo "GH CLI: $(gh --version | head -1)"

# uv (Python)
if ! command -v uv &>/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ln -sf ~/.local/bin/uv /usr/local/bin/uv
  ln -sf ~/.local/bin/uvx /usr/local/bin/uvx
fi
echo "uv: $(uv --version)"

# Claude Code
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code
fi
echo "Claude: $(claude --version 2>/dev/null || echo 'installed')"

# Pi
if ! command -v pi &>/dev/null; then
  npm install -g @anthropic-ai/pi
fi
echo "Pi: $(pi --version 2>/dev/null || echo 'installed')"

# templ (Go HTML templating)
if ! command -v templ &>/dev/null; then
  go install github.com/a-h/templ/cmd/templ@latest
fi

# Create dev user
if ! id mae &>/dev/null; then
  useradd -m -s /bin/bash mae
  echo "mae ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/mae
fi

# SSH key for GH access (will be injected per-sandbox)
mkdir -p /home/mae/.ssh
chmod 700 /home/mae/.ssh
chown -R mae:mae /home/mae/.ssh

# Git config
sudo -u mae git config --global user.name "MAE Sandbox Agent"
sudo -u mae git config --global user.email "mae@rodaddy.live"
sudo -u mae git config --global init.defaultBranch main
sudo -u mae git config --global pull.rebase false

# Clone core repos
REPO_DIR="/home/mae/repos"
mkdir -p "$REPO_DIR"

clone_repo() {
  local org=$1 repo=$2
  local target="$REPO_DIR/$repo"
  if [ ! -d "$target" ]; then
    echo "Cloning $org/$repo..."
    sudo -u mae git clone --depth 1 "https://github.com/$org/$repo.git" "$target" 2>/dev/null || echo "WARN: Failed to clone $org/$repo"
  fi
}

# MAE + King Capital repos
clone_repo King-Capital multi-agent-engine
clone_repo King-Capital king-core
clone_repo King-Capital king-trading
clone_repo King-Capital king-agents
clone_repo King-Capital king-strategies
clone_repo King-Capital king-ingest
clone_repo King-Capital king-dashboard

# Install deps for MAE
if [ -d "$REPO_DIR/multi-agent-engine" ]; then
  cd "$REPO_DIR/multi-agent-engine"
  sudo -u mae bun install 2>/dev/null || true
  cd dashboard && go mod download 2>/dev/null || true
fi

chown -R mae:mae "$REPO_DIR"

# Warm caches
sudo -u mae npm cache ls >/dev/null 2>&1 || true

echo ""
echo "=== Provisioning Complete ==="
echo "Node: $(node --version)"
echo "Bun: $(bun --version)"
echo "Go: $(go version)"
echo "GH: $(gh --version | head -1)"
echo "uv: $(uv --version)"
echo "Repos: $(ls $REPO_DIR | wc -l)"
echo ""
echo "Next: authenticate GH, inject SSH keys, connect to MAE orchestrator"
