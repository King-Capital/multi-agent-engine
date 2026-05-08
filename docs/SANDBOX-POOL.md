# MAE Sandbox Pool

Pre-warmed LXC containers cloned from a golden template for agent isolation during multi-agent runs.

## Golden Image: mae-golden (CT 410)

**Location:** proxmox05 (10.71.20.80)
**Base OS:** Debian 13 (trixie)
**Template:** `TN01_lxc_nvme:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst`
**Storage:** `px05_zfs_disk`
**Features:** nesting=1 (required for systemd 257)

### Installed Tools

| Tool | Version | Path |
|------|---------|------|
| Node.js | 24.15 | /usr/bin/node |
| Bun | 1.3.13 | /usr/local/bin/bun |
| Go | 1.24.3 | /usr/local/go/bin/go |
| GH CLI | 2.92 | /usr/bin/gh |
| uv | 0.11.11 | ~/.local/bin/uv |
| Claude Code | 2.1.133 | /usr/bin/claude |
| Pi | latest | /usr/bin/pi |
| templ | latest | /usr/local/bin/templ |
| Git | 2.47.3 | /usr/bin/git |

### User: mae

- UID 3007, groups: collab, builds
- Shell: zsh + oh-my-zsh
- Passwordless sudo
- SSH key: Skippy-the-Magnificent-one@github (ED25519)
- Git protocol: SSH (git@github.com: insteadOf https://github.com/)

### Repos (~/Development/King-Capital/)

All repos cloned via SSH from King-Capital org:

| Repo | Has Deps | Notes |
|------|----------|-------|
| multi-agent-engine | bun (engine/) + go (dashboard/) | MAE itself |
| king-core | bun | Shared schemas/types |
| king-trading | - | Trading engine |
| king-agents | - | Agent configs |
| king-strategies | - | Strategy library |
| king-ingest | - | Data ingestion |
| king-dashboard | needs npm token | @king-capital/core is private |
| bulkbridge-ai | bun | BulkBridge platform |
| bb-admin-app | empty | Admin frontend |
| bb-client-app | bun | Client frontend |
| supplier-app | empty | Supplier portal |

### Container Config

```
cores: 2
memory: 2048 MiB
swap: 512 MiB
disk: 16 GB (px05_zfs_disk)
network: vmbr0, static IP
features: nesting=1
```

## Spinning Up a Sandbox

### From GH Actions (preferred)

Use the **Sandbox Management** workflow (`sandbox-manage.yml`):

1. Go to Actions > Sandbox Management > Run workflow
2. Choose action: `create`, `provision`, `warm`, or `destroy`
3. Set target IP and VMID

### From CLI (via Proxmox API)

```bash
# Create a clone from the golden snapshot
PVE_TOKEN="PVEAPIToken=root@pam!claude-mcp=<token>"

curl -sk -X POST "https://10.71.1.5:8006/api2/json/nodes/proxmox05/lxc" \
  -H "Authorization: $PVE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "vmid": <new-vmid>,
    "ostemplate": "TN01_lxc_nvme:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst",
    "hostname": "mae-sandbox-<N>",
    "cores": 2, "memory": 2048, "swap": 512,
    "rootfs": "px05_zfs_disk:16",
    "net0": "name=eth0,bridge=vmbr0,ip=<ip>/24,gw=10.71.1.1",
    "unprivileged": 1, "features": "nesting=1", "start": 1
  }'
```

### From mcp2cli

```bash
mcp2cli proxmox-plus create_container --params '{
  "node": "proxmox05",
  "vmid": "<new-vmid>",
  "ostemplate": "TN01_lxc_nvme:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst",
  "hostname": "mae-sandbox-<N>",
  "cores": 2, "memory": 2048, "disk_size": 16,
  "storage": "px05_zfs_disk",
  "network_bridge": "vmbr0",
  "start_after_create": true,
  "unprivileged": true
}'
```

## Keeping It Warm

The nightly `sandbox-warm.yml` workflow (3 AM EDT) runs on all pool containers:
1. `git pull` all repos in `~/Development/King-Capital/`
2. Refresh bun/go deps for MAE + king-core
3. Report tool versions

## VMID Allocation

| VMID | IP | Purpose |
|------|-----|---------|
| 410 | 10.71.20.80 | mae-golden (template, DO NOT DELETE) |
| 411 | 10.71.20.81 | mae-sandbox-1 |
| 412 | 10.71.20.82 | mae-sandbox-2 |
| 413 | 10.71.20.83 | mae-sandbox-3 |
| 414 | 10.71.20.84 | mae-sandbox-4 |

## Proxmox API Token

- User: `root@pam`
- Runners: CT 106 (10.71.20.114), CT 107 (10.71.20.115) -- VLAN 20 only
- Token: `claude-mcp`
- Role: SandboxBuilder (VM.Allocate, VM.Config.*, VM.PowerMgmt, Datastore.*, SDN.Use, Sys.Audit)
- Scope: cluster-wide (/)
