#!/usr/bin/env bash
set -euo pipefail

# MAE Sandbox Pool Manager
# Manages sandbox LXCs cloned from mae-golden (CT 410)

GOLDEN_IP="10.71.20.169"
NODE="proxmox05"
TEMPLATE="TN01_lxc_nvme:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst"
STORAGE="px05_zfs_disk"
PVE_HOST="10.71.1.5"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} $*"; }
ok()  { echo -e "${GREEN}✅ $*${NC}"; }
err() { echo -e "${RED}❌ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }

usage() {
  echo "MAE Sandbox Pool Manager"
  echo ""
  echo "Usage: $0 <command> [options]"
  echo ""
  echo "Commands:"
  echo "  create <vmid> <ip> [hostname]  Create a new sandbox LXC"
  echo "  destroy <vmid>                 Destroy a sandbox (refuses CT 410)"
  echo "  warm [ip]                      Pull repos + refresh deps"
  echo "  status                         Show all sandbox containers"
  echo "  verify [ip]                    Check tools + repos on a sandbox"
}

cmd_create() {
  local vmid="${1:?Usage: $0 create <vmid> <ip> [hostname]}"
  local ip="${2:?Usage: $0 create <vmid> <ip> [hostname]}"
  local hostname="${3:-mae-sandbox-${vmid}}"

  log "Creating CT $vmid ($hostname) at $ip on $NODE"
  log "  Template: $TEMPLATE"
  log "  Storage:  $STORAGE (16GB)"
  log "  Resources: 2 cores, 2GB RAM"
  log "  Features: nesting=1"

  if [ -z "$PVE_TOKEN" ]; then
    err "PVE_TOKEN env var required (PVEAPIToken=root@pam!claude-mcp=<value>)"
    exit 1
  fi

  RESULT=$(curl -sk -X POST "https://${PVE_HOST}:8006/api2/json/nodes/${NODE}/lxc" \
    -H "Authorization: PVEAPIToken=${PVE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"vmid\": ${vmid},
      \"ostemplate\": \"${TEMPLATE}\",
      \"hostname\": \"${hostname}\",
      \"cores\": 2, \"memory\": 2048, \"swap\": 512,
      \"rootfs\": \"${STORAGE}:16\",
      \"net0\": \"name=eth0,bridge=vmbr0,ip=${ip}/24,gw=10.71.1.1\",
      \"unprivileged\": 1, \"features\": \"nesting=1\", \"start\": 1
    }")

  echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('data'):
    print(f'Task: {d[\"data\"]}')
elif d.get('errors'):
    print(f'FAILED: {json.dumps(d[\"errors\"])}')
    sys.exit(1)
"

  log "Waiting for boot..."
  for i in $(seq 1 30); do
    if ping -c1 -W2 "$ip" &>/dev/null; then
      ok "Container $vmid is up (${i}s)"
      break
    fi
    [ $((i % 5)) -eq 0 ] && log "  Still waiting... (${i}s)"
    sleep 2
  done

  log "Checking SSH..."
  for i in $(seq 1 10); do
    if ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no mae@"$ip" "echo ok" &>/dev/null; then
      ok "SSH connected to mae@$ip"
      cmd_verify "$ip"
      return
    fi
    sleep 3
  done
  warn "SSH not reachable yet -- may need key setup"
}

cmd_destroy() {
  local vmid="${1:?Usage: $0 destroy <vmid>}"

  if [ "$vmid" = "410" ]; then
    err "REFUSING to destroy mae-golden (CT 410)"
    exit 1
  fi

  log "Destroying CT $vmid..."
  curl -sk -X POST "https://${PVE_HOST}:8006/api2/json/nodes/${NODE}/lxc/${vmid}/status/stop" \
    -H "Authorization: PVEAPIToken=${PVE_TOKEN}" >/dev/null 2>&1
  sleep 5
  curl -sk -X DELETE "https://${PVE_HOST}:8006/api2/json/nodes/${NODE}/lxc/${vmid}?force=1&purge=1" \
    -H "Authorization: PVEAPIToken=${PVE_TOKEN}" >/dev/null 2>&1
  ok "CT $vmid destroyed"
}

cmd_warm() {
  local ip="${1:-$GOLDEN_IP}"
  log "Warming sandbox at $ip"

  ssh -o StrictHostKeyChecking=no mae@"$ip" "
    cd ~/Development/King-Capital
    for d in */; do
      echo -n \"  \$d: \"
      cd ~/Development/King-Capital/\$d
      git pull --ff-only 2>&1 | tail -1
      cd ~/Development/King-Capital
    done
    echo ''
    echo 'Refreshing deps...'
    source ~/.zshrc 2>/dev/null
    cd ~/Development/King-Capital/multi-agent-engine/engine && bun install 2>&1 | tail -1
    cd ~/Development/King-Capital/king-core && bun install 2>&1 | tail -1
  "
  ok "Warm complete"
}

cmd_verify() {
  local ip="${1:-$GOLDEN_IP}"
  log "Verifying sandbox at $ip"

  ssh -o StrictHostKeyChecking=no mae@"$ip" "
    echo '--- Tools ---'
    echo 'Node:   ' \$(node --version 2>/dev/null || echo MISSING)
    echo 'Bun:    ' \$(bun --version 2>/dev/null || echo MISSING)
    echo 'Go:     ' \$(/usr/local/go/bin/go version 2>/dev/null || echo MISSING)
    echo 'GH CLI: ' \$(gh --version 2>/dev/null | head -1 || echo MISSING)
    echo 'uv:     ' \$(~/.local/bin/uv --version 2>/dev/null || echo MISSING)
    echo 'Claude: ' \$(claude --version 2>/dev/null || echo MISSING)
    echo 'Git:    ' \$(git --version 2>/dev/null || echo MISSING)
    echo ''
    echo '--- Repos ---'
    ls ~/Development/King-Capital/
    echo ''
    echo '--- Disk ---'
    df -h / | tail -1
  "
}

cmd_status() {
  log "Checking sandbox pool..."
  mcp2cli proxmox get_containers 2>&1 | python3 -c "
import sys, json
d = json.load(sys.stdin)
text = d.get('result', {}).get('text', '')
for block in text.split('📦'):
    if 'sandbox' in block.lower() or 'golden' in block.lower() or 'mae' in block.lower():
        print('📦' + block.strip())
        print()
"
}

case "${1:-}" in
  create)  cmd_create "${@:2}" ;;
  destroy) cmd_destroy "${@:2}" ;;
  warm)    cmd_warm "${@:2}" ;;
  verify)  cmd_verify "${@:2}" ;;
  status)  cmd_status ;;
  *)       usage ;;
esac
