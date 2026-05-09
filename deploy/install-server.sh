#!/usr/bin/env bash
set -euo pipefail

# MAE Server Installer
# Sets up a full MAE dashboard + engine server on a fresh Ubuntu/Debian host.
# Run as root or with sudo.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/King-Capital/multi-agent-engine/main/deploy/install-server.sh | sudo bash
#   # or with options:
#   curl -fsSL ... | sudo bash -s -- --domain mae.example.com --gateway-url http://your-llm:4000

APP_DIR="/opt/mae"
MAE_USER="mae"
REPO="https://github.com/King-Capital/multi-agent-engine.git"

info() { echo "  [mae-server] $*"; }
err()  { echo "  [mae-server] ERROR: $*" >&2; exit 1; }

# Parse args
DOMAIN=""
GATEWAY_URL=""
DB_PASS="mae"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)      DOMAIN="$2"; shift 2 ;;
    --gateway-url) GATEWAY_URL="$2"; shift 2 ;;
    --db-pass)     DB_PASS="$2"; shift 2 ;;
    *)             shift ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || err "Must run as root"

echo ""
echo "  Multi-Agent Engine — Server Install"
echo "  ────────────────────────────────────"
echo ""

# 1. System packages
info "Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl ca-certificates git build-essential sudo postgresql postgresql-client >/dev/null

# 2. Bun
if ! command -v bun &>/dev/null; then
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash >/dev/null 2>&1
  ln -sf /usr/local/bin/bun /usr/local/bin/bunx
fi
info "Bun $(bun --version)"

# 3. Go
if ! command -v go &>/dev/null; then
  info "Installing Go..."
  GO_VERSION="1.22.4"
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xzf - >/dev/null
  echo 'export PATH=$PATH:/usr/local/go/bin' > /etc/profile.d/go.sh
  export PATH=$PATH:/usr/local/go/bin
fi
info "Go $(go version | awk '{print $3}')"

# 4. templ
if ! command -v templ &>/dev/null; then
  info "Installing templ..."
  go install github.com/a-h/templ/cmd/templ@latest 2>/dev/null
  ln -sf ~/go/bin/templ /usr/local/bin/templ
fi

# 5. Create mae user
if ! id "$MAE_USER" &>/dev/null; then
  info "Creating $MAE_USER user..."
  useradd -r -m -s /bin/bash "$MAE_USER"
fi

# 6. PostgreSQL
info "Setting up PostgreSQL..."
systemctl enable postgresql >/dev/null 2>&1
systemctl start postgresql
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$MAE_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $MAE_USER WITH PASSWORD '$DB_PASS';" >/dev/null
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$MAE_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $MAE_USER OWNER $MAE_USER;" >/dev/null

# 7. Clone/update repo
if [[ -d "$APP_DIR/.git" ]]; then
  info "Updating existing installation..."
  git -C "$APP_DIR" pull --ff-only 2>/dev/null || true
else
  info "Cloning MAE..."
  mkdir -p "$APP_DIR"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
chown -R "$MAE_USER:$MAE_USER" "$APP_DIR"

# 8. Build engine
info "Building engine..."
sudo -u "$MAE_USER" bash -c "cd $APP_DIR/engine && bun install --silent"

# 9. Build dashboard
info "Building dashboard..."
cd "$APP_DIR/dashboard"
sudo -u "$MAE_USER" bash -c "cd $APP_DIR/dashboard && templ generate ./templates/ 2>/dev/null; go build -o mae-dashboard ."

# 10. Build SPA
info "Building dashboard SPA..."
sudo -u "$MAE_USER" bash -c "cd $APP_DIR/dashboard-next && bun install --silent && ./node_modules/.bin/vite build 2>/dev/null"
sudo -u "$MAE_USER" bash -c "cp -r $APP_DIR/dashboard-next/dist $APP_DIR/dashboard-next-dist"

# 11. Run migrations
info "Running database migrations..."
for f in "$APP_DIR"/dashboard/migrations/*.sql; do
  PGPASSWORD="$DB_PASS" psql -h localhost -U "$MAE_USER" -d "$MAE_USER" -f "$f" 2>/dev/null || true
done

# 12. Create systemd service
info "Installing systemd service..."
cat > /etc/systemd/system/mae-dashboard.service <<EOF
[Unit]
Description=MAE Dashboard
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=$MAE_USER
Group=$MAE_USER
WorkingDirectory=$APP_DIR/dashboard
ExecStart=$APP_DIR/dashboard/mae-dashboard
Environment=DATABASE_URL=postgres://$MAE_USER:$DB_PASS@localhost:5432/$MAE_USER?sslmode=disable
Environment=DASHBOARD_PORT=8400
Environment=MAE_LLM_GATEWAY_URL=$GATEWAY_URL
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mae-dashboard >/dev/null 2>&1
systemctl restart mae-dashboard

# 13. Verify
sleep 3
if curl -sf http://localhost:8400/api/health >/dev/null 2>&1; then
  info "Dashboard is running on port 8400"
else
  info "WARNING: Dashboard may not have started. Check: journalctl -u mae-dashboard"
fi

echo ""
info "Server install complete!"
echo ""
echo "  Dashboard:  http://$(hostname -I | awk '{print $1}'):8400"
echo "  Config:     $APP_DIR/.env"
echo "  Logs:       journalctl -u mae-dashboard -f"
echo ""
if [[ -n "$DOMAIN" ]]; then
  echo "  To expose publicly:"
  echo "    1. Set up a reverse proxy (Caddy, nginx) pointing to localhost:8400"
  echo "    2. Point $DOMAIN DNS to this host"
fi
echo ""
