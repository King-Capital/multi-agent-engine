import type { LogSink, LogEntry } from "./logger";

interface LangfuseSinkConfig {
  publicKey: string;
  secretKey: string;
  host: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
}

export function createLangfuseSink(config: LangfuseSinkConfig): LogSink {
  const {
    publicKey,
    secretKey,
    host,
    flushIntervalMs = 5000,
    maxBatchSize = 50,
  } = config;

  const buffer: Array<{ id: string; type: string; timestamp: string; body: Record<string, unknown> }> = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let currentTraceId: string | null = null;
  const auth = btoa(`${publicKey}:${secretKey}`);

  function ensureTimer(): void {
    if (!flushTimer) {
      flushTimer = setInterval(() => { void doFlush(); }, flushIntervalMs);
    }
  }

  async function doFlush(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, maxBatchSize);

    try {
      const res = await fetch(`${host}/api/public/ingestion`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({ batch }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        process.stderr.write(`[langfuse-sink] Flush failed: ${res.status} ${body.slice(0, 200)}\n`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[langfuse-sink] Flush error: ${msg}\n`);
    }
  }

  function genId(): string {
    return crypto.randomUUID();
  }

  const sink: LogSink = {
    write(entry: LogEntry): void {
      const sessionId = entry.session_id as string | undefined;

      if (entry.msg === "Session started" || (!currentTraceId && sessionId)) {
        currentTraceId = sessionId ?? genId();
        buffer.push({
          id: genId(),
          type: "trace-create",
          timestamp: entry.ts,
          body: {
            id: currentTraceId,
            name: (entry.goal as string) ?? entry.msg,
            metadata: {
              chain: entry.chain,
              component: entry.component,
              config_hash: entry.config_hash,
            },
            sessionId,
          },
        });
      }

      if (entry.level === "ERROR" || entry.level === "CRITICAL") {
        buffer.push({
          id: genId(),
          type: "event-create",
          timestamp: entry.ts,
          body: {
            traceId: currentTraceId,
            name: entry.msg,
            level: entry.level === "CRITICAL" ? "ERROR" : "WARNING",
            metadata: { ...entry, ts: undefined, level: undefined, msg: undefined },
          },
        });
      }

      if (entry.component && (entry.agent_id || entry.level === "INFO")) {
        buffer.push({
          id: genId(),
          type: "event-create",
          timestamp: entry.ts,
          body: {
            traceId: currentTraceId,
            name: `[${entry.component}] ${entry.msg}`,
            level: entry.level === "WARN" ? "WARNING" : entry.level === "ERROR" ? "ERROR" : "DEFAULT",
            metadata: { agent_id: entry.agent_id, ...entry },
          },
        });
      }

      if (buffer.length >= maxBatchSize) {
        void doFlush();
      }
      ensureTimer();
    },

    async flush(): Promise<void> {
      while (buffer.length > 0) {
        await doFlush();
      }
    },

    async close(): Promise<void> {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      await this.flush!();
      currentTraceId = null;
    },
  };

  return sink;
}
