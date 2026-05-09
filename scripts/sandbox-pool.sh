#!/usr/bin/env bash
set -euo pipefail

# MAE Sandbox Pool Manager (v6)
# Golden image is a vzdump backup -- no live CT
# Sandboxes: restore from backup, 512MB warm, activate to 4GB

BACKUP="/mnt/pve/TN01_backups_nfs/dump/vzdump-lxc-410-2026_05_07-22_13_20.tar.zst"
NODE="${NODE:-proxmox05}"
STORAGE="px05_zfs_disk"
PVE="${PVE_API:-https://localhost:8006/api2/json}"
SANDBOX_SUBNET="${MAE_SANDBOX_SUBNET:-10.0.0}"
SANDBOX_HOST_OFFSET="${MAE_SANDBOX_HOST_OFFSET:-81}"

: "${PVE_TOKEN:?Set PVE_TOKEN env var}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

create() {
  local num=$1
  local vmid=$((800 + num))
  local ip="${SANDBOX_SUBNET}.$((SANDBOX_HOST_OFFSET + num - 1))"
  local name="mae-sandbox-$num"

  log "Restoring backup -> CT $vmid ($name at $ip)"
  curl -sk -X POST "$PVE/nodes/$NODE/lxc" \
    -H "Authorization: PVEAPIToken=$PVE_TOKEN" \
    -d "vmid=$vmid&hostname=$name&storage=$STORAGE&unprivileged=1" \
    -d "ostemplate=$BACKUP" \
    -d "restore=1"

  log "Waiting for restore..."
  sleep 60

  log "Configuring: network, nesting, 512MB warm"
  curl -sk -X PUT "$PVE/nodes/$NODE/lxc/$vmid/config" \
    -H "Authorization: PVEAPIToken=$PVE_TOKEN" \
    -d "net0=name%3Deth0%2Cbridge%3Dvmbr0%2Ctag%3D20%2Cip%3D${ip}%2F24%2Cgw%3D${MAE_SANDBOX_GATEWAY:-10.0.0.1}%2Cfirewall%3D0" \
    -d "features=nesting%3D1" \
    -d "memory=512"

  log "Starting $name"
  curl -sk -X POST "$PVE/nodes/$NODE/lxc/$vmid/status/start" \
    -H "Authorization: PVEAPIToken=$PVE_TOKEN"

  log "✅ $name ($vmid) at $ip -- warm @ 512MB"
}

activate() {
  local num=$1
  local vmid=$((800 + num))
  log "Activating CT $vmid -> 4GB RAM (no reboot)"
  curl -sk -X PUT "$PVE/nodes/$NODE/lxc/$vmid/config" \
    -H "Authorization: PVEAPIToken=$PVE_TOKEN" -d "memory=4096"
  log "✅ CT $vmid active @ 4GB"
}

deactivate() {
  local num=$1
  local vmid=$((800 + num))
  log "Deactivating CT $vmid -> 512MB RAM (no reboot)"
  curl -sk -X PUT "$PVE/nodes/$NODE/lxc/$vmid/config" \
    -H "Authorization: PVEAPIToken=$PVE_TOKEN" -d "memory=512"
  log "✅ CT $vmid idle @ 512MB"
}

destroy() {
  local num=$1
  local vmid=$((800 + num))
  log "Stopping CT $vmid"
  curl -sk -X POST "$PVE/nodes/$NODE/lxc/$vmid/status/stop" \
    -H "Authorization: PVEAPIToken=$PVE_TOKEN"
  sleep 5
  log "Destroying CT $vmid"
  curl -sk -X DELETE "$PVE/nodes/$NODE/lxc/$vmid" \
    -H "Authorization: PVEAPIToken=$PVE_TOKEN"
  log "✅ CT $vmid destroyed"
}

case "${1:-}" in
  create)     create "${2:?Usage: $0 create <1-4>}" ;;
  activate)   activate "${2:?Usage: $0 activate <1-4>}" ;;
  deactivate) deactivate "${2:?Usage: $0 deactivate <1-4>}" ;;
  destroy)    destroy "${2:?Usage: $0 destroy <1-4>}" ;;
  batch-create)
    for i in 1 2 3 4; do create $i; done ;;
  batch-destroy)
    for i in 1 2 3 4; do destroy $i; done ;;
  *)
    echo "MAE Sandbox Pool (v6)"
    echo ""
    echo "Usage: $0 <command> <sandbox-num>"
    echo ""
    echo "  create 1      Restore mae-sandbox-1 from backup @ 512MB"
    echo "  activate 1    Scale to 4GB RAM (no reboot)"
    echo "  deactivate 1  Scale to 512MB RAM (no reboot)"
    echo "  destroy 1     Stop + destroy"
    echo "  batch-create  Create all 4 sequentially"
    echo "  batch-destroy Destroy all 4"
    ;;
esac
