# MAE Sandbox Pool -- Reference (v4)

## Golden Image

- **VMID:** 1000 (`mae-golden-image`) -- stopped LXC on proxmox05
- **Note:** Clones can target any Proxmox node, not just proxmox05
- **Snapshot:** `mae-golden-v1`
- **Storage:** px05_zfs_disk
- **Backup:** TN01_backups_nfs (`vzdump-lxc-410-2026_05_07-22_13_20.tar.zst`)

## VMID / IP Map (VMID 80X -> IP .8X)

| VMID | IP | Name |
|------|----|------|
| 1000 | 10.71.20.80 | mae-golden-image (stopped, do not use) |
| 801 | 10.71.20.81 | mae-sandbox-1 |
| 802 | 10.71.20.82 | mae-sandbox-2 |
| 803 | 10.71.20.83 | mae-sandbox-3 |
| 804 | 10.71.20.84 | mae-sandbox-4 |
| 805-809 | 10.71.20.85-89 | Expansion |

## Clone a Sandbox

```bash
VMID=801
NAME="mae-sandbox-1"
IP="10.71.20.81"

pct clone 1000 $VMID --snapname mae-golden-v1 --hostname $NAME --storage px05_zfs_disk --full
pct set $VMID -net0 name=eth0,bridge=vmbr0,tag=20,ip=${IP}/24,gw=10.71.20.1,firewall=0
pct set $VMID -features nesting=1
pct start $VMID
```

## Batch Create

```bash
for i in 1 2 3 4; do
  vmid=$((800 + i))
  ip="10.71.20.$((80 + i))"
  pct clone 1000 $vmid --snapname mae-golden-v1 --hostname "mae-sandbox-${i}" --storage px05_zfs_disk --full
  pct set $vmid -net0 name=eth0,bridge=vmbr0,tag=20,ip=${ip}/24,gw=10.71.20.1,firewall=0
  pct set $vmid -features nesting=1
  pct start $vmid
  echo "mae-sandbox-${i} (${vmid}) at ${ip} -- started"
done
```

## Proxmox API

```bash
TOKEN="PVEAPIToken=root@pam!claude-mcp=<secret>"
PVE="https://10.71.1.9:8006/api2/json"

# Clone
curl -sk -X POST "$PVE/nodes/proxmox05/lxc/1000/clone" \
  -H "Authorization: $TOKEN" \
  -d "newid=801&hostname=mae-sandbox-1&snapname=mae-golden-v1&storage=px05_zfs_disk&full=1"

# Configure (omit hwaddr for auto MAC)
curl -sk -X PUT "$PVE/nodes/proxmox05/lxc/801/config" \
  -H "Authorization: $TOKEN" \
  -d "net0=name%3Deth0%2Cbridge%3Dvmbr0%2Ctag%3D20%2Cip%3D10.71.20.81%2F24%2Cgw%3D10.71.20.1%2Cfirewall%3D0" \
  -d "features=nesting%3D1"

# Start
curl -sk -X POST "$PVE/nodes/proxmox05/lxc/801/status/start" \
  -H "Authorization: $TOKEN"

# Stop + Destroy
curl -sk -X POST "$PVE/nodes/proxmox05/lxc/801/status/stop" \
  -H "Authorization: $TOKEN"
curl -sk -X DELETE "$PVE/nodes/proxmox05/lxc/801" \
  -H "Authorization: $TOKEN"
```

## SSH

Clones inherit authorized_keys from golden image. All pre-authorized:
Rico, Air (skippy), bilby, cc-king, cc-kevin, cc-geetesh, ct106/107 runners, Skippy-the-Magnificent-one

## Updating Golden Image

```bash
pct start 1000
ssh root@10.71.20.80  # make changes
pct stop 1000
pct snapshot 1000 mae-golden-v2 --description "what changed"
# Future clones: --snapname mae-golden-v2
```

## What's Installed

Node 24, Bun 1.3.13, Go 1.24.3, templ 0.3.1001, GH CLI 2.92.0, uv 0.11.11, Claude Code 2.1.133, Pi
User `mae` (UID 3007, collab+builds, zsh, sudo, ~/Development/)

## Network

- VLAN 20 (tag=20 on vmbr0)
- Gateway: 10.71.20.1
- DNS: 10.71.1.220, 10.71.1.222, 1.1.1.1

## Runner Firewall

CT 106/107 iptables allows `10.71.20.80/29` (covers .80-.87). If expanding past .87, update `/etc/iptables/rules.v4` on both runners.

## Ansible (provision from scratch)

```bash
cd projects/pai-infra/ansible
ansible-playbook -i inventory/hosts.yml playbooks/lxc-baseline.yml --limit mae_sandboxes
ansible-playbook -i inventory/hosts.yml playbooks/mae-sandbox-golden.yml --extra-vars "github_token=ghp_..."
```
