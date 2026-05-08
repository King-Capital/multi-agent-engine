# MAE Sandbox Pool -- Reference (v6)

## Golden Image

- **No live CT** -- golden image is a vzdump backup only
- **Backup:** `TN01_backups_nfs:/dump/vzdump-lxc-410-2026_05_07-22_13_20.tar.zst`
- **Node:** proxmox05 (restore target)
- **Storage:** px05_zfs_disk (sandbox disk)

## VMID / IP Map (VMID 80X -> IP .8X)

| VMID | IP | Name |
|------|----|------|
| 801 | 10.71.20.81 | mae-sandbox-1 |
| 802 | 10.71.20.82 | mae-sandbox-2 |
| 803 | 10.71.20.83 | mae-sandbox-3 |
| 804 | 10.71.20.84 | mae-sandbox-4 |
| 805-809 | 10.71.20.85-89 | Expansion |

## Create a Sandbox (restore from backup)

```bash
VMID=801
NAME="mae-sandbox-1"
IP="10.71.20.81"
BACKUP="/mnt/pve/TN01_backups_nfs/dump/vzdump-lxc-410-2026_05_07-22_13_20.tar.zst"

pct restore $VMID $BACKUP --storage px05_zfs_disk --hostname $NAME --unprivileged 1
pct set $VMID -net0 name=eth0,bridge=vmbr0,tag=20,ip=${IP}/24,gw=10.71.20.1,firewall=0
pct set $VMID -features nesting=1 -memory 512
pct start $VMID
```

## Batch Create (warm pool at 512MB)

```bash
BACKUP="/mnt/pve/TN01_backups_nfs/dump/vzdump-lxc-410-2026_05_07-22_13_20.tar.zst"

for i in 1 2 3 4; do
  vmid=$((800 + i))
  ip="10.71.20.$((80 + i))"
  pct restore $vmid $BACKUP --storage px05_zfs_disk --hostname "mae-sandbox-${i}" --unprivileged 1
  pct set $vmid -net0 name=eth0,bridge=vmbr0,tag=20,ip=${ip}/24,gw=10.71.20.1,firewall=0
  pct set $vmid -features nesting=1 -memory 512
  pct start $vmid
  echo "mae-sandbox-${i} (${vmid}) at ${ip} -- warm @ 512MB"
done
```

## Activate / Deactivate

```bash
# Scale up for agent work (instant, no reboot)
pct set 801 -memory 4096

# Scale back to idle (instant, no reboot)
pct set 801 -memory 512
```

## Proxmox API

```bash
TOKEN="PVEAPIToken=root@pam!claude-mcp=<secret>"
PVE="https://10.71.1.9:8006/api2/json"

# Restore from backup
curl -sk -X POST "$PVE/nodes/proxmox05/lxc" \
  -H "Authorization: $TOKEN" \
  -d "vmid=801&hostname=mae-sandbox-1&storage=px05_zfs_disk&unprivileged=1" \
  -d "ostemplate=/mnt/pve/TN01_backups_nfs/dump/vzdump-lxc-410-2026_05_07-22_13_20.tar.zst" \
  -d "restore=1"

# Configure (512MB warm)
curl -sk -X PUT "$PVE/nodes/proxmox05/lxc/801/config" \
  -H "Authorization: $TOKEN" \
  -d "net0=name%3Deth0%2Cbridge%3Dvmbr0%2Ctag%3D20%2Cip%3D10.71.20.81%2F24%2Cgw%3D10.71.20.1%2Cfirewall%3D0" \
  -d "features=nesting%3D1" \
  -d "memory=512"

# Start
curl -sk -X POST "$PVE/nodes/proxmox05/lxc/801/status/start" \
  -H "Authorization: $TOKEN"

# Activate (4GB) / Deactivate (512MB)
curl -sk -X PUT "$PVE/nodes/proxmox05/lxc/801/config" \
  -H "Authorization: $TOKEN" -d "memory=4096"
curl -sk -X PUT "$PVE/nodes/proxmox05/lxc/801/config" \
  -H "Authorization: $TOKEN" -d "memory=512"

# Stop + Destroy
curl -sk -X POST "$PVE/nodes/proxmox05/lxc/801/status/stop" \
  -H "Authorization: $TOKEN"
curl -sk -X DELETE "$PVE/nodes/proxmox05/lxc/801" \
  -H "Authorization: $TOKEN"
```

## SSH

Sandboxes inherit authorized_keys from golden image. All pre-authorized:
Rico, Air (skippy), bilby, cc-king, cc-kevin, cc-geetesh, ct106/107 runners, Skippy-the-Magnificent-one

## Updating Golden Image

```bash
# Restore backup to temp CT, modify, re-backup
pct restore 999 /mnt/pve/TN01_backups_nfs/dump/vzdump-lxc-410-2026_05_07-22_13_20.tar.zst \
  --storage px05_zfs_disk --hostname mae-golden-temp --unprivileged 1
pct set 999 -net0 name=eth0,bridge=vmbr0,tag=20,ip=10.71.20.80/24,gw=10.71.20.1,firewall=0
pct set 999 -features nesting=1
pct start 999
ssh root@10.71.20.80  # make changes
pct stop 999
vzdump 999 --storage px05_zfs_disk-backups --mode stop --compress zstd
cp /px05_zfs_disk/backups/dump/vzdump-lxc-999-*.tar.zst /mnt/pve/TN01_backups_nfs/dump/
pct destroy 999 --force --purge
# Update BACKUP path in scripts to new filename
```

## What's Installed

Node 24, Bun 1.3.13, Go 1.24.3, templ 0.3.1001, GH CLI 2.92.0, uv 0.11.11, Claude Code 2.1.133, Pi
User `mae` (UID 3007, collab+builds, zsh, sudo, ~/Development/)

## Runner Firewall

CT 106/107 iptables allows `10.71.20.80/29` (covers .80-.87). If expanding past .87, update `/etc/iptables/rules.v4` on both runners.
