# Deploy Langfuse on proxmox05

> Hand this to an infra session. Use `/deploy-service` skill.

## What

Langfuse — open-source LLM observability platform. MIT licensed. Self-hosted.
Purpose: trace visualization, evaluation, prompt versioning for MAE.

## Where

- **Node:** proxmox05 (10.71.1.9) — Ryzen 9 7940HS, 64GB, ZFS
- **CTID:** Pick next available in 270-280 range (MAE infra block)
- **IP:** Assign from VLAN 20 (10.71.20.x)
- **Port:** 3000 (Langfuse default)
- **DNS:** langfuse.internal or langfuse.lan (Pi-hole)
- **Reverse proxy:** Caddy on CT 100 (if desired, not required for LAN)

## LXC Spec

- **Template:** debian-12 or ubuntu-24.04
- **Resources:** 4 cores, 4GB RAM, 20GB disk (Langfuse is lightweight)
- **Nesting:** Yes (Docker inside LXC)
- **Network:** dual NIC (VLAN 1 + VLAN 20) per standard

## Install Steps

### 1. Install Docker
```bash
apt update && apt install -y docker.io docker-compose-v2
systemctl enable --now docker
```

### 2. Create Langfuse directory
```bash
mkdir -p /opt/langfuse && cd /opt/langfuse
```

### 3. Docker Compose
```yaml
# /opt/langfuse/docker-compose.yml
version: "3.9"
services:
  langfuse-server:
    image: langfuse/langfuse:latest
    restart: always
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://langfuse:langfuse@db:5432/langfuse
      - NEXTAUTH_SECRET=GENERATE_A_SECRET_HERE
      - SALT=GENERATE_A_SALT_HERE
      - NEXTAUTH_URL=http://10.71.20.XX:3000
      - TELEMETRY_ENABLED=false
      - LANGFUSE_ENABLE_EXPERIMENTAL_FEATURES=true
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:16-alpine
    restart: always
    environment:
      - POSTGRES_USER=langfuse
      - POSTGRES_PASSWORD=langfuse
      - POSTGRES_DB=langfuse
    volumes:
      - langfuse_pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U langfuse"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  langfuse_pg_data:
```

### 4. Generate secrets
```bash
NEXTAUTH_SECRET=$(openssl rand -base64 32)
SALT=$(openssl rand -base64 32)
sed -i "s|GENERATE_A_SECRET_HERE|${NEXTAUTH_SECRET}|" docker-compose.yml
sed -i "s|GENERATE_A_SALT_HERE|${SALT}|" docker-compose.yml
```

### 5. Update NEXTAUTH_URL with actual IP
```bash
# Replace 10.71.20.XX with the assigned IP
sed -i "s|10.71.20.XX|ACTUAL_IP|" docker-compose.yml
```

### 6. Start
```bash
docker compose up -d
```

### 7. Verify
```bash
curl -s http://localhost:3000/api/public/health | jq .
# Should return: {"status":"OK"}
```

### 8. Create initial user
Open http://ACTUAL_IP:3000 in browser, sign up with email/password.
Create a project called "MAE". Note the public/secret API keys.

## Post-Deploy

### Store API keys in Vaultwarden
- Name: `langfuse-mae`
- Fields: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`

### Update MAE .env
```
LANGFUSE_PUBLIC_KEY=pk-...
LANGFUSE_SECRET_KEY=sk-...
LANGFUSE_HOST=http://10.71.20.XX:3000
```

### DNS (Pi-hole)
Add: `langfuse.lan` → assigned IP on both Pi-holes (CT 104 + CT 206)

### HOSTMAP
Update infrastructure/HOSTMAP.md with new CT entry.

## Verification

```bash
# From Mac Mini (or any LAN machine)
curl -s http://langfuse.lan:3000/api/public/health
# {"status":"OK"}

# Test trace ingestion
curl -X POST http://langfuse.lan:3000/api/public/ingestion \
  -H "Content-Type: application/json" \
  -u "pk-...:sk-..." \
  -d '{"batch":[{"id":"test-1","type":"trace-create","body":{"name":"test-trace"}}]}'
# Should return 207 with successes
```
