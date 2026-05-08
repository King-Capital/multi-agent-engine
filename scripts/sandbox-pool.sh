#!/usr/bin/env bash
set -euo pipefail

# MAE Sandbox Pool Manager
# Creates, warms, and manages a pool of pre-provisioned dev LXCs
# Usage: sandbox-pool.sh <create|status|destroy|warm> [options]

POOL_PREFIX="mae-sandbox"
NODE="${NODE:-proxmox05}"
TEMPLATE="${TEMPLATE:-TN01_lxc_nvme:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst}"
STORAGE="${STORAGE:-TN01_lxc_nvme}"
BRIDGE="${BRIDGE:-vmbr0}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-2048}"
DISK="${DISK:-16}"
POOL_SIZE="${POOL_SIZE:-3}"
START_VMID="${START_VMID:-400}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
  echo "MAE Sandbox Pool Manager"
  echo ""
  echo "Usage: $0 <command> [options]"
  echo ""
  echo "Commands:"
  echo "  create    Create N sandbox LXCs (default: $POOL_SIZE)"
  echo "  status    Show pool status"
  echo "  warm      Re-provision/update all pool LXCs"
  echo "  destroy   Destroy all pool LXCs"
  echo "  assign    Assign a free sandbox to an agent session"
  echo "  release   Release a sandbox back to the pool"
  echo ""
  echo "Environment:"
  echo "  NODE=$NODE  POOL_SIZE=$POOL_SIZE  CORES=$CORES  MEMORY=$MEMORY"
  echo "  START_VMID=$START_VMID  TEMPLATE=$TEMPLATE"
}

create_sandbox() {
  local vmid=$1
  local hostname="${POOL_PREFIX}-${vmid}"
  
  echo -e "${YELLOW}Creating LXC $vmid ($hostname) on $NODE...${NC}"
  
  mcp2cli proxmox-plus create_container --params "{
    \"node\": \"$NODE\",
    \"vmid\": \"$vmid\",
    \"ostemplate\": \"$TEMPLATE\",
    \"hostname\": \"$hostname\",
    \"cores\": $CORES,
    \"memory\": $MEMORY,
    \"disk_size\": $DISK,
    \"storage\": \"$STORAGE\",
    \"network_bridge\": \"$BRIDGE\",
    \"start_after_create\": true,
    \"unprivileged\": true,
    \"password\": \"mae-sandbox-$(date +%s)\"
  }" 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('text',d.get('message','')))" || true
  
  echo -e "${GREEN}Created $hostname${NC}"
}

cmd_create() {
  echo "Creating sandbox pool ($POOL_SIZE containers starting at VMID $START_VMID)..."
  for i in $(seq 0 $((POOL_SIZE - 1))); do
    local vmid=$((START_VMID + i))
    create_sandbox "$vmid"
  done
  echo -e "\n${GREEN}Pool created. Run '$0 warm' to provision dev tools.${NC}"
}

cmd_status() {
  echo "MAE Sandbox Pool Status:"
  mcp2cli proxmox-plus get_containers --params "{\"node\": \"$NODE\"}" 2>&1 | python3 -c "
import sys, json
d = json.load(sys.stdin)
text = d.get('result', {}).get('text', '')
for block in text.split('📦'):
    if 'mae-sandbox' in block.lower() or 'sandbox' in block.lower():
        print('📦' + block)
"
}

cmd_warm() {
  echo "Warming sandbox pool (provisioning dev tools)..."
  local script_dir="$(cd "$(dirname "$0")" && pwd)"
  
  for i in $(seq 0 $((POOL_SIZE - 1))); do
    local vmid=$((START_VMID + i))
    local ip=$(get_container_ip "$vmid")
    if [ -n "$ip" ]; then
      echo -e "${YELLOW}Provisioning sandbox $vmid at $ip...${NC}"
      scp -o StrictHostKeyChecking=no "$script_dir/sandbox-provision.sh" "root@${ip}:/tmp/"
      ssh -o StrictHostKeyChecking=no "root@${ip}" "bash /tmp/sandbox-provision.sh"
      echo -e "${GREEN}Sandbox $vmid provisioned${NC}"
    else
      echo -e "${RED}Cannot reach sandbox $vmid -- is it running?${NC}"
    fi
  done
}

cmd_destroy() {
  echo -e "${RED}Destroying sandbox pool...${NC}"
  for i in $(seq 0 $((POOL_SIZE - 1))); do
    local vmid=$((START_VMID + i))
    echo "Stopping and deleting LXC $vmid..."
    mcp2cli proxmox-plus stop_container --params "{\"selector\": \"$vmid\"}" 2>/dev/null || true
    sleep 2
    mcp2cli proxmox-plus delete_container --params "{\"node\": \"$NODE\", \"vmid\": \"$vmid\"}" 2>/dev/null || true
  done
  echo -e "${GREEN}Pool destroyed${NC}"
}

get_container_ip() {
  # Get IP from container config -- placeholder, needs network detection
  echo ""
}

case "${1:-}" in
  create)  cmd_create ;;
  status)  cmd_status ;;
  warm)    cmd_warm ;;
  destroy) cmd_destroy ;;
  *)       usage ;;
esac
