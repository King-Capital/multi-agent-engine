# MAE Deployment Guide

## Architecture Overview

MAE has two components that can run on different hosts:

| Component | Type | Where | Notes |
|-----------|------|-------|-------|
| **Dashboard** | Persistent Go server | `$MAE_DASHBOARD_HOST` | Serves UI + API, receives events |
| **Engine CLI** | Per-invocation | Any host with bun | Runs agents, streams events to dashboard |
| PostgreSQL 18 | Database | localhost:5432 (on dashboard host) | Session state, users, agents, events |
| Caddy | Reverse proxy | `$MAE_PROXY_HOST` | TLS termination for your-domain.example.com |

The engine CLI can run from **any machine** and stream events to the central dashboard using:
```bash
# Environment variable (recommended -- add to .bashrc/.zshrc)
export MAE_DASHBOARD_URL="http://your-dashboard:8400"  # Set in ~/.mae/config

# Or per-invocation flag
bun engine/cli.ts task "your task" --dashboard "$MAE_DASHBOARD_URL"
```

## Dashboard Server Setup

### Prerequisites

- Ubuntu 24.04 LXC (4 cores, 8GB RAM, 32GB disk, dual NIC)
- Network access to GitHub and apt repositories

### Steps

1. **Create LXC** on Proxmox: Ubuntu 24.04, 4 cores, 8GB RAM, 32GB disk, dual NIC
2. **Run provisioning script:**
   ```bash
   bash deploy/setup-lxc.sh
   ```
3. **Install and start dashboard service:**
   ```bash
   cp deploy/mae-dashboard.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now mae-dashboard
   ```
4. **Add Caddy snippet** to your reverse proxy's Caddyfile (see `caddy-snippet.txt`)
5. **Add DNS record:** `your-domain.example.com` -> `$MAE_PROXY_HOST` via your DNS provider
6. **Verify:**
   ```bash
   curl https://your-domain.example.com/api/users
   ```

### Dashboard Port

The dashboard listens on **port 8400** (set via `DASHBOARD_PORT` in the systemd unit).

### Logs

```bash
journalctl -u mae-dashboard -f
```

## Remote CLI Setup (any host)

For hosts that only need to **run the engine** (not the dashboard), setup is lightweight:

### Prerequisites

- bun (any recent version)
- git with SSH access to King-Capital org
- Network access to `$MAE_DASHBOARD_HOST`:8400

### Steps

```bash
# 1. Clone the repo
git clone git@github.com:King-Capital/multi-agent-engine.git
cd multi-agent-engine

# 2. Install engine dependencies
cd engine && bun install && cd ..

# 3. Set dashboard URL (add to shell profile)
echo 'export MAE_DASHBOARD_URL="http://your-dashboard:8400"  # Set in ~/.mae/config' >> ~/.bashrc
source ~/.bashrc

# 4. Verify connectivity
curl -s "$MAE_DASHBOARD_URL/api/users" | head -5

# 5. Test with dry run (echo adapter, no LLM calls)
bun engine/cli.ts task "test connectivity" --dry-run

# 6. Build standalone binary (optional)
cd engine && bun build cli.ts --target=bun --outfile=../agent && cd ..
# Now you can run: ./agent task "your task"
```

### Known Hosts

| Host | IP | Role | Status |
|------|-----|------|--------|
| Dashboard server | `$MAE_DASHBOARD_HOST` | Dashboard + PG + full stack | Deployed |
| Agent host | `$MAE_AGENT_HOST` | CLI client, streams to dashboard | Setup ready |
| Additional client | `$MAE_CLIENT_HOST` | CLI client, streams to dashboard | Pending setup |

### Adapter Selection

The CLI auto-detects available adapters. To use a specific one:
```bash
# Claude Code (requires `claude` CLI installed)
bun engine/cli.ts task "your task" --adapter claude-code

# OpenAI Codex (requires `codex` CLI installed)
bun engine/cli.ts task "your task" --adapter codex

# Dry run (no LLM calls)
bun engine/cli.ts task "your task" --dry-run
```

## Users (seeded by migration)

Customize users in `dashboard/migrations/001_initial.sql`. Default seed:

| User | UID | Role |
|------|-----|------|
| admin | 3000 | admin |

## Running the Engine

```bash
# From any host with MAE_DASHBOARD_URL set:

# Plan-build-review (default chain)
bun engine/cli.ts task "add input validation to the signup handler"

# Specific chain
bun engine/cli.ts chain swarm-review "review the auth module"

# Reusable prompt
bun engine/cli.ts run review "git diff HEAD~1"

# Using justfile shortcuts (requires `just`)
just task "add rate limiting"
just swarm "review security module"
just dry "test the pipeline"
```

Events stream to the dashboard in real-time. Open https://your-domain.example.com to watch.
