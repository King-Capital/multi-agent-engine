# MAE Sandbox Pool

Pre-warmed LXC containers cloned from a golden snapshot for agent isolation during multi-agent runs.

## Golden Image

- **VMID:** 410
- **Snapshot:** mae-golden-v1
- **Node:** proxmox05
- **IP:** 10.71.20.80
- **Storage:** px05_zfs_disk
- **Base template:** TN01_lxc_nvme:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst
- **OS:** Debian 13 (trixie), 4 cores, 4GB RAM, 16GB disk, nesting=1

### Tools

Node 24.15, Bun 1.3.13, Go 1.24.3, templ, GH CLI 2.92, uv 0.11.11, Claude Code 2.1.133, Pi, Git 2.47.3

### User: mae

UID 3007, groups: collab+builds, zsh + oh-my-zsh, passwordless sudo

### Repos (~/Development/King-Capital/)

multi-agent-engine, king-core, king-trading, king-agents, king-strategies, king-ingest, king-dashboard, bulkbridge-ai, bb-admin-app, bb-client-app, supplier-app

## Pool Allocation

| Name | VMID | IP | Purpose |
|------|------|----|---------|
| mae-golden | 410 | 10.71.20.80 | Template (do not use directly) |
| mae-sandbox-1 | 411 | 10.71.20.81 | Agent sandbox |
| mae-sandbox-2 | 412 | 10.71.20.82 | Agent sandbox |
| mae-sandbox-3 | 413 | 10.71.20.83 | Agent sandbox |
| mae-sandbox-4 | 414 | 10.71.20.84 | Agent sandbox |
| (spare) | 415-419 | 10.71.20.85-89 | Reserved for expansion |

## Spinning Up Sandboxes

### Clone via API

```bash
# Clone from golden snapshot
curl -sk -X POST "https://10.71.1.5:8006/api2/json/nodes/proxmox05/lxc/410/clone" \
  -H "Authorization: PVEAPIToken=root@pam!claude-mcp=<secret>" \
  -d "newid=411&hostname=mae-sandbox-1&snapname=mae-golden-v1&storage=px05_zfs_disk&full=1"

# Set network (omit hwaddr to auto-generate MAC -- CRITICAL to avoid ARP conflicts)
curl -sk -X PUT "https://10.71.1.5:8006/api2/json/nodes/proxmox05/lxc/411/config" \
  -H "Authorization: PVEAPIToken=root@pam!claude-mcp=<secret>" \
  -d "net0=name%3Deth0%2Cbridge%3Dvmbr0%2Ctag%3D20%2Cip%3D10.71.20.81%2F24%2Cgw%3D10.71.20.1%2Cfirewall%3D0"

# Start
curl -sk -X POST "https://10.71.1.5:8006/api2/json/nodes/proxmox05/lxc/411/status/start" \
  -H "Authorization: PVEAPIToken=root@pam!claude-mcp=<secret>"
```

### Clone via pct (on proxmox05)

```bash
pct clone 410 411 --snapname mae-golden-v1 --hostname mae-sandbox-1 --storage px05_zfs_disk --full
pct set 411 -net0 name=eth0,bridge=vmbr0,tag=20,ip=10.71.20.81/24,gw=10.71.20.1,firewall=0
pct set 411 -features nesting=1 -onboot 0
pct start 411
```

## Network

- **VLAN:** 20 (tag=20 on vmbr0)
- **Gateway:** 10.71.20.1 (UCG Fiber)
- **Subnet:** 10.71.20.0/24
- **DNS:** 10.71.1.220, 10.71.1.222, 1.1.1.1

## SSH Access

Shared `mae-sandbox` keypair (ed25519) deployed to: Rico's Mac, Air (skippy), bilby (CT 271), cc-king (CT 320), cc-kevin (CT 321), cc-geetesh (CT 322), runner CT 106 (10.71.20.114), runner CT 107 (10.71.20.115).

Additional authorized keys: Skippy GH, bilby, king/kevin/geetesh cc-lxcs, both runners.

## Proxmox API Token

- **Token:** `root@pam!claude-mcp`
- **Role:** SandboxBuilder
- **Permissions:** VM.Allocate, VM.Snapshot, VM.Clone, VM.Config.*, VM.PowerMgmt, VM.Console, Datastore.AllocateSpace, Datastore.AllocateTemplate, Datastore.Audit, SDN.Use, Sys.Audit, Sys.Console

## Runner Firewall

Runners have iptables OUTPUT whitelist. Sandbox range `10.71.20.80/29` is allowed for SSH. If expanding beyond .87, update `/etc/iptables/rules.v4` on both runners.

## Cleanup

```bash
# Via API
curl -sk -X POST ".../lxc/411/status/stop" -H "Authorization: ..."
curl -sk -X DELETE ".../lxc/411" -H "Authorization: ..."

# Via pct
pct stop 411 && pct destroy 411
```

## Ansible (full provision from scratch)

```bash
cd projects/pai-infra/ansible
ansible-playbook -i inventory/hosts.yml playbooks/lxc-baseline.yml --limit mae_sandboxes
ansible-playbook -i inventory/hosts.yml playbooks/mae-sandbox-golden.yml --extra-vars "github_token=ghp_..."
```
