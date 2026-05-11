# Langfuse v3 — Updated Docker Compose

> The original spec had 2 services. Langfuse v3 requires 6. Update the compose on CT 273.

## Why 6 Services

Langfuse v3 moved trace analytics to ClickHouse (millisecond queries on millions of spans), async processing to Redis, and large payload storage to MinIO. All required — the app won't start without them.

## Resources (fits easily on px05's 64GB)

| Service | RAM | CPU |
|---------|-----|-----|
| langfuse-web | 1-2 GB | 1 core |
| langfuse-worker | 1 GB | 1 core |
| PostgreSQL 17 | 1 GB | 1 core |
| ClickHouse 24.3 | 2-4 GB | 2 cores |
| Redis 7 | 256 MB | 0.5 core |
| MinIO | 256 MB | 0.5 core |
| **Total** | **~6-8 GB** | **6 cores** |

## Docker Compose (full v3)

Reference the official compose: https://github.com/langfuse/langfuse/blob/main/docker-compose.yml

Key env vars to set:
```
DATABASE_URL=postgresql://langfuse:GENERATED_PASS@db:5432/langfuse
CLICKHOUSE_URL=http://clickhouse:8123
CLICKHOUSE_MIGRATION_URL=clickhouse://clickhouse:9000
REDIS_CONNECTION_STRING=redis://redis:6379
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=GENERATED_PASS
S3_BUCKET_NAME=langfuse
S3_REGION=auto
NEXTAUTH_SECRET=GENERATED
SALT=GENERATED
ENCRYPTION_KEY=GENERATED (must be exactly 64 hex chars = 32 bytes)
NEXTAUTH_URL=http://10.71.20.73:3000
TELEMETRY_ENABLED=false
LANGFUSE_ENABLE_EXPERIMENTAL_FEATURES=true
```

## MinIO Setup Note

MinIO needs a bucket created on first start:
```bash
docker compose exec minio mc alias set local http://localhost:9000 minioadmin GENERATED_PASS
docker compose exec minio mc mb local/langfuse
```

Or use the `createbuckets` init container from the official compose.
