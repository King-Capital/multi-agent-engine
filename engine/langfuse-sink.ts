import type { LogSink, LogEntry } from "./logger";

interface LangfuseSinkConfig {
  publicKey: string;
  secretKey: string;
  host: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
}

export function createLangfuseSink(config: LangfuseSinkConfig): LogSink {
  const { publicKey, secretKey, host, flushIntervalMs = 3000, maxBatchSize = 100 } = config;

  const buffer: Array<Record<string, unknown>> = [];
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
        headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
        body: JSON.stringify({ batch }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        process.stderr.write(`[langfuse-sink] Flush failed: ${res.status} ${body.slice(0, 300)}\n`);
      }
    } catch (err: unknown) {
      process.stderr.write(`[langfuse-sink] Flush error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  function uid(): string { return crypto.randomUUID(); }

  const sink: LogSink = {
    write(entry: LogEntry): void {
      const sessionId = entry.session_id as string | undefined;

      // Session start → Langfuse trace
      if (entry.msg === "Session started") {
        currentTraceId = sessionId ?? uid();
        buffer.push({
          id: uid(), type: "trace-create", timestamp: entry.ts,
          body: {
            id: currentTraceId,
            name: (entry.name as string) ?? (entry.task_preview as string) ?? "MAE Session",
            sessionId,
            input: entry.task_preview ?? entry.goal,
            metadata: { chain: entry.chain, dashboard: entry.dashboard },
          },
        });
        ensureTimer();
        return;
      }

      // Session end → update trace
      if (entry.msg === "Session ended" && currentTraceId) {
        buffer.push({
          id: uid(), type: "trace-create", timestamp: entry.ts,
          body: {
            id: currentTraceId,
            output: `Status: ${entry.status}, Cost: $${entry.cost_usd ?? entry.total_cost ?? 0}`,
            metadata: { status: entry.status, cost_usd: entry.cost_usd ?? entry.total_cost },
          },
        });
        ensureTimer();
        return;
      }

      if (!currentTraceId) return;

      // Agent delegation → Langfuse span (represents agent work)
      if (entry.msg === "Delegating to echo agent" || entry.msg?.toString().startsWith("Delegating")) {
        const spanId = uid();
        buffer.push({
          id: spanId, type: "span-create", timestamp: entry.ts,
          body: {
            id: spanId,
            traceId: currentTraceId,
            name: (entry.agent as string) ?? "Agent",
            input: (entry.prompt_preview as string)?.slice(0, 500),
            metadata: {
              model: entry.model,
              team: entry.team,
              domain_write: entry.domain_write,
              system_prompt_length: entry.system_prompt_length,
            },
          },
        });
        ensureTimer();
        return;
      }

      // Team delegation → Langfuse span
      if (entry.msg === "Delegating to team") {
        const spanId = uid();
        buffer.push({
          id: spanId, type: "span-create", timestamp: entry.ts,
          body: {
            id: spanId,
            traceId: currentTraceId,
            name: `Team: ${entry.team ?? "unknown"}`,
            metadata: { team: entry.team },
          },
        });
        ensureTimer();
        return;
      }

      // Worker spawn → Langfuse span
      if (entry.msg === "Lead briefed, spawning workers") {
        const spanId = uid();
        buffer.push({
          id: spanId, type: "span-create", timestamp: entry.ts,
          body: {
            id: spanId,
            traceId: currentTraceId,
            name: `Workers: ${(entry.workers as string[])?.join(", ") ?? "unknown"}`,
            metadata: { team: entry.team, worker_count: entry.worker_count, workers: entry.workers },
          },
        });
        ensureTimer();
        return;
      }

      // Lead review → Langfuse span
      if (entry.msg === "Lead reviewing workers") {
        const spanId = uid();
        buffer.push({
          id: spanId, type: "span-create", timestamp: entry.ts,
          body: {
            id: spanId,
            traceId: currentTraceId,
            name: `Review: ${entry.lead ?? "Lead"}`,
            metadata: { lead: entry.lead, worker_count: entry.worker_count },
          },
        });
        ensureTimer();
        return;
      }

      // Status transition → Langfuse event
      if (entry.msg === "Status transition") {
        const evtId = uid();
        buffer.push({
          id: evtId, type: "event-create", timestamp: entry.ts,
          body: {
            id: evtId,
            traceId: currentTraceId,
            name: `Status: ${entry.from} → ${entry.to}`,
            level: entry.to === "error" ? "ERROR" : entry.to === "paused" ? "WARNING" : "DEFAULT",
            metadata: { from: entry.from, to: entry.to, source: entry.source },
          },
        });
        ensureTimer();
        return;
      }

      // Errors → Langfuse event with ERROR level
      if (entry.level === "ERROR" || entry.level === "CRITICAL") {
        const evtId = uid();
        buffer.push({
          id: evtId, type: "event-create", timestamp: entry.ts,
          body: {
            id: evtId,
            traceId: currentTraceId,
            name: `[${entry.component}] ${entry.msg}`,
            level: "ERROR",
            metadata: { error: entry.error, agent_id: entry.agent_id, component: entry.component },
          },
        });
        ensureTimer();
        return;
      }

      if (buffer.length >= maxBatchSize) void doFlush();
    },

    async flush(): Promise<void> {
      while (buffer.length > 0) await doFlush();
    },

    async close(): Promise<void> {
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      await this.flush!();
      currentTraceId = null;
    },
  };

  return sink;
}
