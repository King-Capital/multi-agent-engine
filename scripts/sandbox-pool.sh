#!/usr/bin/env bash
set -euo pipefail

# MAE Sandbox Pool Manager (v4)
# Golden image: VMID 1000, Sandboxes: 801-804

GOLDEN=1000
SNAPSHOT="mae-golden-v1"
NODE="${NODE:-proxmox05}"
STORAGE="px05_zfs_disk"
PVE="https://10.71.1.9:8006/api2/json"

: "${PVE_TOKEN:?Set PVE_TOKEN env var}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

clone() {
  local num=$1
  local vmid=$((800 + num))
  local ip="10.71.20.$((80 + num))"
  local name="mae-sandbox-$num"

  log "Cloning $GOLDEN -> $vmid ($name at $ip)"
  curl -sk -X POST "$PVE/nodes/$NODE/lxc/$GOLDEN/clone" \
    -H "Authorization: PVEAPIToken=$PVE_TOKEN" \
    -d "newid=$vmid&hostname=$name&snapname=$SNAPSHOT&storage=$STORAGE&full=1"

  log "Waiting for clone to complete..."
  sleep 60

  log "Configuring network + nesting"
  curl -sk -X PUT "$PVE/nodes/$NODE/lxc/$vmid/config" \
    -H "Authorization: PVEAPIToken=$PVE_TOKEN" \
    -d "net0=name%3Deth0%2Cbridge%3Dvmbr0%2Ctag%3D20%2Cip%3D${ip}%2F24%2Cgw%3D10.71.20.1%2Cfirewall%3D0" \
    -d "features=nesting%3D1"

  log "Starting $name"
  curl -sk -X POST "$PVE/nodes/$NODE/lxc/$vmid/status/start" \
    -H "Authorization: PVEAPIToken=$PVE_TOKEN"

  log "✅ $name ($vmid) at $ip"
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
  clone)   clone "${2:?Usage: $0 clone <1-4>}" ;;
  destroy) destroy "${2:?Usage: $0 destroy <1-4>}" ;;
  batch-clone)
    for i in 1 2 3 4; do clone $i; done ;;
  batch-destroy)
    for i in 1 2 3 4; do destroy $i; done ;;
  *)
    echo "Usage: $0 <clone|destroy|batch-clone|batch-destroy> [sandbox-num]"
    echo ""
    echo "  clone 1        Clone mae-sandbox-1 (VMID 801, IP 10.71.20.81)"
    echo "  destroy 2      Destroy mae-sandbox-2 (VMID 802)"
    echo "  batch-clone    Clone all 4 sandboxes sequentially"
    echo "  batch-destroy  Destroy all 4 sandboxes"
    ;;
esac
