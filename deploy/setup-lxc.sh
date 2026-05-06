#!/bin/bash
set -euo pipefail

# MAE Dashboard LXC Provisioning
# Run as root on a fresh Ubuntu 24.04 LXC
# Usage: bash setup-lxc.sh

echo "=== MAE Dashboard LXC Setup ==="

# 1. PostgreSQL Global Development Group apt repository (for PG 18)
apt-get install -y curl ca-certificates gnupg lsb-release
echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg

# 2. System packages
apt-get update && apt-get upgrade -y
apt-get install -y \
  curl ca-certificates git build-essential \
  postgresql-17 postgresql-client-17 \
  sudo

# 3. Install Bun (system-wide)
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# 4. Install Go 1.22+
GO_VERSION="1.22.4"
curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xzf -
echo 'export PATH=$PATH:/usr/local/go/bin' >> /etc/profile.d/go.sh
export PATH=$PATH:/usr/local/go/bin

# 5. Create system groups and users (matching homelab-users.conf UIDs)
groupadd -g 3000 rico   || true
groupadd -g 3001 collab || true

useradd -u 3000 -g 3000 -G collab -m -s /bin/bash rico       || true
useradd -u 3001 -g 3001 -m -s /bin/bash kevin                 || true
useradd -u 3005 -g 3001 -m -s /bin/bash lisa                  || true
useradd -u 3002 -g 3001 -m -s /bin/bash geetesh               || true
useradd -u 3004 -g 3001 -s /usr/sbin/nologin skippy           || true
useradd -u 3006 -g 3001 -s /usr/sbin/nologin bilby            || true

# 7. Create mae service user
useradd -r -s /usr/sbin/nologin mae || true

# 8. PostgreSQL setup
systemctl enable postgresql
systemctl start postgresql

sudo -u postgres psql <<'EOSQL'
CREATE USER mae WITH PASSWORD 'mae';
CREATE DATABASE mae OWNER mae;
\c mae
-- Run migration from deploy/migrations/001_initial.sql after clone
EOSQL

# 9. Clone and build
APP_DIR="/opt/mae"
mkdir -p "$APP_DIR"
chown mae:mae "$APP_DIR"

cd "$APP_DIR"
git clone https://github.com/rodaddy/multi-agent-engine.git .

# Build engine
cd engine
bun install
cd ..

# Build dashboard
cd dashboard
go build -o mae-dashboard .
cd ..

# 10. Run migration
sudo -u postgres psql -d mae -f dashboard/migrations/001_initial.sql

# 11. Create directories
mkdir -p /var/log/mae
chown mae:mae /var/log/mae

echo "=== Setup complete ==="
echo "Next: install systemd unit"
echo "  cp deploy/mae-dashboard.service /etc/systemd/system/"
echo "  systemctl daemon-reload"
echo "  systemctl enable --now mae-dashboard"
echo "Next: add Caddy reverse proxy entry on CT 205 (see deploy/caddy-snippet.txt)"
echo "Next: add DNS record for ai-agents.rodaddy.live -> 10.71.20.55 via Pi-hole"
