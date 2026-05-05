# MAE Dashboard Deployment

## Prerequisites

- Ubuntu 24.04 LXC (4 cores, 8GB RAM, 32GB disk, dual NIC)
- Network access to GitHub and apt repositories

## Steps

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
4. **Add Caddy snippet** to CT 205's Caddyfile (see `caddy-snippet.txt`), replacing `10.71.20.72` with the MAE container's LAN IP
5. **Add DNS record:** `ai-agents.rodaddy.live` -> CT 205 (10.71.20.55) via Pi-hole
6. **Verify:**
   ```bash
   curl https://ai-agents.rodaddy.live/api/users
   ```

## Architecture

| Component | Type | Port | Notes |
|-----------|------|------|-------|
| mae-dashboard | Persistent Go server | 3000 | Systemd service, serves UI + API |
| mae engine | CLI (per-invocation) | — | `bun cli.ts run <team> <task>`, posts events to dashboard |
| PostgreSQL 18 | Database | 5432 (localhost) | Session state, users, agents, events |
| Caddy (CT 205) | Reverse proxy | 443 | Terminates TLS for ai-agents.rodaddy.live |

## Users (seeded by migration)

| User | UID | Role |
|------|-----|------|
| rico | 3000 | admin |
| kevin | 3001 | user |
| lisa | 3005 | user |
| geetesh | 3002 | user |
| skippy | 3004 | agent |
| bilby | 3006 | agent |

## Logs

```bash
journalctl -u mae-dashboard -f
```

## Running the Engine

The engine is a CLI tool, not a background service:
```bash
cd /opt/mae/engine
bun cli.ts run <team> "<task description>"
```
Events stream to the dashboard in real-time via SSE.
