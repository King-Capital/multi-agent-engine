import type { LogSink, LogEntry } from "./logger";
import { readFileSync } from "fs";
import { sanitizeAgentInput } from "./security";

interface LangfuseSinkConfig {
  publicKey: string;
  secretKey: string;
  host: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
}

const release = readVersion();
const environment = process.env.MAE_ENV ?? "development";

function readVersion(): string {
  try {
    return readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  } catch {
    return "unknown";
  }
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function createLangfuseSink(config: LangfuseSinkConfig): LogSink {
  const { publicKey, secretKey, host, flushIntervalMs = 3000, maxBatchSize = 100 } = config;

  const buffer: Array<Record<string, unknown>> = [];
  const pendingScores: Promise<void>[] = [];
  const agentSpanIds = new Map<string, string>();
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

  async function postScore(traceId: string, name: string, value: number, comment: string): Promise<void> {
    try {
      await fetch(`${host}/api/public/scores`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
        body: JSON.stringify({ name, traceId, value, comment }),
      });
    } catch (err: unknown) {
      process.stderr.write(`[langfuse-sink] Score post failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  function queueScore(traceId: string, name: string, value: number | undefined, comment: string): void {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    pendingScores.push(postScore(traceId, name, clamp01(value), comment));
  }

  function computeAndSendScores(traceId: string, entry: LogEntry): void {
    const status = String(entry.status ?? "").toLowerCase();
    if (status) {
      const value = status === "completed" ? 1 : status === "partial" || status === "paused" ? 0.5 : 0;
      queueScore(traceId, "session_completion", value, `Session ended with status ${status}.`);
    }

    const cost = numberValue(entry.cost_usd) ?? numberValue(entry.total_cost);
    const budgetLimit =
      numberValue(entry.budget_limit)
      ?? numberValue(entry.budget_limit_usd)
      ?? numberValue(entry.max_per_session_usd);
    if (cost !== undefined && budgetLimit !== undefined && budgetLimit > 0) {
      queueScore(traceId, "cost_efficiency", 1 - cost / budgetLimit, `Cost $${cost.toFixed(4)} against $${budgetLimit.toFixed(4)} budget.`);
    }

    const successfulWorkers = numberValue(entry.successful_workers) ?? numberValue(entry.workers_succeeded);
    const totalWorkers = numberValue(entry.total_workers) ?? numberValue(entry.worker_count);
    if (successfulWorkers !== undefined && totalWorkers !== undefined && totalWorkers > 0) {
      queueScore(traceId, "worker_success_rate", successfulWorkers / totalWorkers, `${successfulWorkers}/${totalWorkers} workers succeeded.`);
    }

    const stepsCompleted = numberValue(entry.steps_completed);
    const stepsTotal = numberValue(entry.steps_total);
    if (stepsCompleted !== undefined && stepsTotal !== undefined && stepsTotal > 0) {
      queueScore(traceId, "chain_step_completion", stepsCompleted / stepsTotal, `${stepsCompleted}/${stepsTotal} chain steps completed.`);
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
            userId: (entry.user_id as string) ?? (entry.initiator as string) ?? "mae-engine",
            release,
            environment,
            tags: [entry.chain, entry.adapter].filter(Boolean),
            input: {
              goal: entry.goal ?? entry.name ?? "unknown",
              task: entry.task ?? entry.task_preview,
              chain: entry.chain,
            },
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
            output: {
              status: entry.status,
              cost_usd: entry.cost_usd ?? entry.total_cost ?? 0,
              duration_ms: entry.duration_ms,
              steps_completed: entry.steps_completed,
              steps_total: entry.steps_total,
              agents_used: entry.agents_used,
              errors: entry.error_count ?? 0,
            },
            metadata: { status: entry.status, cost_usd: entry.cost_usd ?? entry.total_cost },
          },
        });
        computeAndSendScores(currentTraceId, entry);
        ensureTimer();
        return;
      }

      if (!currentTraceId) return;

      if (entry.trace_type === "agent.start") {
        const spanId = uid();
        if (entry.agent_id) agentSpanIds.set(entry.agent_id as string, spanId);
        buffer.push({
          id: spanId, type: "span-create", timestamp: entry.ts,
          body: {
            id: spanId,
            traceId: currentTraceId,
            name: (entry.persona as string) ?? (entry.agent as string) ?? (entry.agent_id as string) ?? "Agent",
            input: (entry.prompt_preview as string | undefined)?.slice(0, 500),
            metadata: {
              agent_id: entry.agent_id,
              model: entry.model,
              team: entry.team,
              role: entry.role,
              skills: entry.skills,
              working_dir: entry.working_dir,
              system_prompt_length: entry.system_prompt_length,
              prompt_name: entry.prompt_name,
              prompt_version: entry.prompt_version,
              prompt_hash: entry.prompt_hash,
              prompt_context_repo: entry.prompt_context_repo,
              prompt_context_root: entry.prompt_context_root,
              prompt_context_stack: entry.prompt_context_stack,
            },
          },
        });
        ensureTimer();
        return;
      }

      if (entry.trace_type === "llm.call") {
        const genId = uid();
        const agentId = entry.agent_id as string | undefined;
        const promptTokens = numberValue(entry.prompt_tokens) ?? 0;
        const completionTokens = numberValue(entry.completion_tokens) ?? 0;
        buffer.push({
          id: genId, type: "generation-create", timestamp: entry.ts,
          body: {
            id: genId,
            traceId: currentTraceId,
            parentObservationId: agentId ? agentSpanIds.get(agentId) : undefined,
            name: `${entry.persona ?? entry.agent_id ?? "llm"}`,
            model: entry.model,
            promptName: entry.prompt_name,
            promptVersion: entry.prompt_version,
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: numberValue(entry.total_tokens) ?? promptTokens + completionTokens,
            },
            metadata: {
              agent_id: agentId,
              team: entry.team,
              cost_usd: entry.cost,
              cache_read_tokens: entry.cache_read_tokens,
              prompt_hash: entry.prompt_hash,
              prompt_context_repo: entry.prompt_context_repo,
              prompt_context_root: entry.prompt_context_root,
              prompt_context_stack: entry.prompt_context_stack,
            },
          },
        });
        ensureTimer();
        return;
      }

      if (entry.trace_type === "tool.call") {
        const spanId = uid();
        const agentId = entry.agent_id as string | undefined;
        buffer.push({
          id: spanId, type: "span-create", timestamp: entry.ts,
          body: {
            id: spanId,
            traceId: currentTraceId,
            parentObservationId: agentId ? agentSpanIds.get(agentId) : undefined,
            name: `tool/${entry.tool ?? "unknown"}`,
            input: entry.args_preview ? sanitizeAgentInput(String(entry.args_preview)).slice(0, 200) : undefined,
            output: entry.output_preview ? sanitizeAgentInput(String(entry.output_preview)).slice(0, 500) : undefined,
            metadata: { success: entry.success, exit_code: entry.exit_code },
          },
        });
        ensureTimer();
        return;
      }

      if (entry.trace_type === "agent.end") {
        const agentId = entry.agent_id as string | undefined;
        const existingSpanId = agentId ? agentSpanIds.get(agentId) : undefined;
        if (existingSpanId) {
          buffer.push({
            id: uid(), type: "span-update", timestamp: entry.ts,
            body: {
              id: existingSpanId,
              traceId: currentTraceId,
              endTime: entry.ts,
              output: {
                grade: entry.grade,
                output_preview: entry.output_preview,
                cost_usd: entry.cost,
                tokens: entry.tokens,
              },
            },
          });
          agentSpanIds.delete(agentId!);
          ensureTimer();
        }
        return;
      }

      // Agent delegation → Langfuse span (represents agent work)
      if (entry.msg === "Delegating to echo agent" || entry.msg?.toString().startsWith("Delegating")) {
        const spanId = uid();
        if (entry.agent_id) agentSpanIds.set(entry.agent_id as string, spanId);
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
      const scores = pendingScores.splice(0);
      if (scores.length > 0) await Promise.allSettled(scores);
    },

    async close(): Promise<void> {
      if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
      await this.flush!();
      currentTraceId = null;
      agentSpanIds.clear();
    },
  };

  return sink;
}
