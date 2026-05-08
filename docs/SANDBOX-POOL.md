# MAE Sandbox Pool

Pre-warmed LXC containers for agent isolation during multi-agent runs.

## Architecture

```
MAE Orchestrator
  └─ assigns sandbox LXC per agent
       ├─ Node.js 24 + Bun + Go
       ├─ Claude Code + Pi CLI
       ├─ GH CLI (authenticated)
       ├─ uv (Python)
       ├─ All King Capital repos (shallow clone)
       └─ Git configured + SSH keys
```

## Pool Config

| Setting | Default | Notes |
|---------|---------|-------|
| Node | proxmox05 | 62GB RAM, 16 cores |
| Pool size | 3 | Start small, scale up |
| Cores/container | 2 | Enough for builds |
| RAM/container | 2 GB | Sufficient for agent work |
| Disk/container | 16 GB | Repos + node_modules + caches |
| VMID range | 400-409 | Reserved for sandbox pool |
| Base OS | Debian 13 | Standard Proxmox template |

## Usage

```bash
# Create pool
scripts/sandbox-pool.sh create

# Provision dev tools on all containers
scripts/sandbox-pool.sh warm

# Check status
scripts/sandbox-pool.sh status

# Destroy pool
scripts/sandbox-pool.sh destroy
```

## Keeping It Warm

A cron job on proxmox05 runs nightly to:
1. `git pull` all repos in each sandbox
2. `bun install` / `go mod download` to refresh deps
3. Check tool versions and update if needed

```cron
0 3 * * * /opt/mae/scripts/sandbox-warm.sh
```

## Integration with MAE

The orchestrator assigns sandboxes via the pool API:
- `POST /api/sandbox/assign` -- get a free sandbox for an agent
- `POST /api/sandbox/release` -- return sandbox to pool after agent completes
- `GET /api/sandbox/status` -- pool health

Each agent gets SSH access to its assigned sandbox. Work is isolated -- 
agents can't see each other's containers. After release, the sandbox 
is cleaned (git reset, temp files removed) and returned to the pool.

## Prerequisites

1. Debian 13 template on proxmox05: `Template already on TN01_lxc_nvme (NFS shared across all nodes)`
2. VLAN 20 network access (vmbr0 bridge)
3. Proxmox MCP token with AllocateTemplate permission (for automated template downloads)
