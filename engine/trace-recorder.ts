/**
 * JSONL Trace Recorder
 *
 * A LogSink that writes one JSONL trace file per session to disk.
 * Every session gets a trace file at {TRACE_DIR}/{session_id}.jsonl.
 *
 * Event types follow specs/trace-schema.md. Log entries are mapped
 * to trace events based on component and message content.
 *
 * Always active -- not gated by env vars.
 */

import type { LogSink, LogEntry } from "./logger";
import { mkdirSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { sanitizeAgentInput } from "./security";
import { TRACE_DIR } from "./trace-artifacts";

export { TRACE_DIR };

type TraceType =
  | "session.start"
  | "session.end"
  | "participant.start"
  | "participant.activity"
  | "participant.heartbeat"
  | "participant.stale"
  | "participant.end"
  | "agent.start"
  | "agent.end"
  | "agent.error"
  | "chain.step.start"
  | "chain.step.end"
  | "tool.call"
  | "llm.call"
  | "self_heal"
  | "verify"
  | "orch.decision"
  | "log";

/**
 * Map a log entry's component + message to a trace schema event type.
 */
function mapLogToTraceType(entry: LogEntry): TraceType {
  if (isTraceType(entry.trace_type)) return entry.trace_type;

  const comp = (entry.component ?? "").toLowerCase();
  const msg = (entry.msg ?? "").toLowerCase();

  // Participant lifecycle
  if (msg.includes("participant event")) {
    if (isTraceType(entry.trace_type)) return entry.trace_type;
  }

  // Session lifecycle
  if (comp === "orchestrator") {
    if (msg.includes("session started")) return "session.start";
    if (msg.includes("session ended") || msg.includes("session failed")) return "session.end";
  }

  // Chain step lifecycle
  if (comp === "chain-runner") {
    if (msg.includes("step") && (msg.includes("starting") || msg.includes("begin"))) return "chain.step.start";
    if (msg.includes("step") && (msg.includes("complete") || msg.includes("done") || msg.includes("failed") || msg.includes("skipped"))) return "chain.step.end";
  }

  // Agent lifecycle (adapters)
  if (comp === "pi-adapter" || comp === "a2a-adapter" || comp === "echo-adapter") {
    if (msg.includes("delegat") && (msg.includes("start") || msg.includes("spawn") || msg.includes("running"))) return "agent.start";
    if (msg.includes("delegat") && (msg.includes("complete") || msg.includes("done") || msg.includes("finish"))) return "agent.end";
    if (msg.includes("error") || msg.includes("fail") || msg.includes("timeout")) return "agent.error";
  }

  // Agent lifecycle (team execution, self-healing)
  if (comp === "team-execution" || comp === "self-healing") {
    if (msg.includes("spawn") || msg.includes("start") || msg.includes("delegat")) return "agent.start";
    if (msg.includes("complete") || msg.includes("done") || msg.includes("grade")) return "agent.end";
    if (msg.includes("heal") || msg.includes("retry") || msg.includes("upgrade")) return "self_heal";
    if (msg.includes("error") || msg.includes("fail")) return "agent.error";
  }

  // Tool calls
  if (comp.includes("adapter") && (msg.includes("tool") || msg.includes("bash") || msg.includes("read") || msg.includes("write") || msg.includes("edit"))) {
    return "tool.call";
  }

  // LLM calls
  if (comp.includes("adapter") && (msg.includes("llm") || msg.includes("model") || msg.includes("token"))) {
    return "llm.call";
  }

  // Self-healing
  if (msg.includes("self-heal") || msg.includes("self_heal")) return "self_heal";

  // Verification
  if (msg.includes("verif") || msg.includes("typecheck") || msg.includes("tsc") || msg.includes("bun test")) {
    return "verify";
  }

  // Orchestrator decisions
  if (comp === "orchestrator" && (msg.includes("decision") || msg.includes("retry") || msg.includes("skip") || msg.includes("escalat"))) {
    return "orch.decision";
  }

  return "log";
}

function isTraceType(value: unknown): value is TraceType {
  return typeof value === "string" && [
    "session.start", "session.end", "participant.start", "participant.activity",
    "participant.heartbeat", "participant.stale", "participant.end",
    "agent.start", "agent.end", "agent.error",
    "chain.step.start", "chain.step.end", "tool.call", "llm.call",
    "self_heal", "verify", "orch.decision", "log",
  ].includes(value);
}

/**
 * Extract trace-schema-relevant fields from a log entry based on type.
 */
function extractTraceFields(entry: LogEntry, traceType: TraceType): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  // Always include component and message
  fields.component = entry.component;
  fields.msg = entry.msg;
  fields.level = entry.level;

  // Include agent_id if present
  if (entry.agent_id) fields.agent_id = entry.agent_id;

  switch (traceType) {
    case "session.start":
      if (entry.goal !== undefined) fields.goal = entry.goal;
      if (entry.chain !== undefined) fields.chain = entry.chain;
      if (entry.name !== undefined) fields.goal = entry.name; // name used as goal
      if (entry.working_dir !== undefined) fields.working_dir = entry.working_dir;
      if (entry.config_hash !== undefined) fields.config_hash = entry.config_hash;
      if (entry.task !== undefined) fields.task_preview = String(entry.task).slice(0, 500);
      if (entry.dashboard !== undefined) fields.dashboard = entry.dashboard;
      break;

    case "session.end":
      if (entry.status !== undefined) fields.status = entry.status;
      if (entry.duration_ms !== undefined) fields.duration_ms = entry.duration_ms;
      if (entry.total_cost !== undefined) fields.total_cost = entry.total_cost;
      if (entry.cost_usd !== undefined) fields.total_cost = entry.cost_usd;
      if (entry.total_tokens !== undefined) fields.total_tokens = entry.total_tokens;
      break;

    case "participant.start":
    case "participant.activity":
    case "participant.heartbeat":
    case "participant.stale":
    case "participant.end":
      if (entry.participant_id !== undefined) fields.participant_id = entry.participant_id;
      if (entry.name !== undefined) fields.name = entry.name;
      if (entry.kind !== undefined) fields.kind = entry.kind;
      if (entry.status !== undefined) fields.status = entry.status;
      if (entry.role !== undefined) fields.role = entry.role;
      if (entry.team !== undefined) fields.team = entry.team;
      if (entry.model !== undefined) fields.model = entry.model;
      if (entry.current_task !== undefined) fields.current_task = String(entry.current_task).slice(0, 500);
      if (entry.current_tool !== undefined) fields.current_tool = entry.current_tool;
      if (entry.last_event !== undefined) fields.last_event = entry.last_event;
      if (entry.last_heartbeat_ts !== undefined) fields.last_heartbeat_ts = entry.last_heartbeat_ts;
      if (entry.cost_usd !== undefined) fields.cost_usd = entry.cost_usd;
      if (entry.tokens_used !== undefined) fields.tokens_used = entry.tokens_used;
      if (entry.capabilities !== undefined) fields.capabilities = entry.capabilities;
      if (entry.reason !== undefined) fields.reason = sanitizeAgentInput(String(entry.reason)).slice(0, 500);
      break;

    case "agent.start":
      if (entry.persona !== undefined) fields.persona = entry.persona;
      if (entry.model !== undefined) fields.model = entry.model;
      if (entry.team !== undefined) fields.team = entry.team;
      if (entry.role !== undefined) fields.role = entry.role;
      if (entry.tools !== undefined) fields.tools = entry.tools;
      break;

    case "agent.end":
      if (entry.grade !== undefined) fields.grade = entry.grade;
      if (entry.duration_ms !== undefined) fields.duration_ms = entry.duration_ms;
      if (entry.cost !== undefined) fields.cost = entry.cost;
      if (entry.cost_usd !== undefined) fields.cost = entry.cost_usd;
      if (entry.tokens !== undefined) fields.tokens = entry.tokens;
      if (entry.output_preview !== undefined) fields.output_preview = String(entry.output_preview).slice(0, 500);
      if (entry.output_hash !== undefined) fields.output_hash = entry.output_hash;
      if (entry.output_artifact !== undefined) fields.output_artifact = entry.output_artifact;
      if (entry.output_bytes !== undefined) fields.output_bytes = entry.output_bytes;
      break;

    case "agent.error":
      if (entry.error !== undefined) fields.error = entry.error;
      if (entry.error_type !== undefined) fields.error_type = entry.error_type;
      if (entry.retry_count !== undefined) fields.retry_count = entry.retry_count;
      break;

    case "chain.step.start":
    case "chain.step.end":
      if (entry.step !== undefined) fields.step = entry.step;
      if (entry.name !== undefined) {
        fields.name = entry.name;
        fields.step_name = entry.name;
      }
      if (entry.team !== undefined) fields.team = entry.team;
      if (entry.status !== undefined) fields.status = entry.status;
      if (entry.duration_ms !== undefined) fields.duration_ms = entry.duration_ms;
      if (entry.reason !== undefined) fields.reason = sanitizeAgentInput(String(entry.reason)).slice(0, 500);
      if (entry.error_type !== undefined) fields.error_type = entry.error_type;
      if (entry.error_preview !== undefined) fields.error_preview = String(entry.error_preview).slice(0, 500);
      break;

    case "tool.call":
      if (entry.tool !== undefined) fields.tool = entry.tool;
      if (entry.args_preview !== undefined) fields.args_preview = String(entry.args_preview).slice(0, 200);
      if (entry.success !== undefined) fields.success = entry.success;
      if (entry.duration_ms !== undefined) fields.duration_ms = entry.duration_ms;
      if (entry.exit_code !== undefined) fields.exit_code = entry.exit_code;
      break;

    case "llm.call":
      if (entry.model !== undefined) fields.model = entry.model;
      if (entry.prompt_tokens !== undefined) fields.prompt_tokens = entry.prompt_tokens;
      if (entry.completion_tokens !== undefined) fields.completion_tokens = entry.completion_tokens;
      if (entry.duration_ms !== undefined) fields.duration_ms = entry.duration_ms;
      if (entry.cost !== undefined) fields.cost = entry.cost;
      break;

    case "self_heal":
      if (entry.trigger !== undefined) fields.trigger = entry.trigger;
      if (entry.action !== undefined) fields.action = entry.action;
      if (entry.from_model !== undefined) fields.from_model = entry.from_model;
      if (entry.to_model !== undefined) fields.to_model = entry.to_model;
      if (entry.attempt !== undefined) fields.attempt = entry.attempt;
      break;

    case "verify":
      if (entry.check !== undefined) fields.check = entry.check;
      if (entry.check_type !== undefined) fields.check_type = entry.check_type;
      if (entry.pass !== undefined) fields.pass = entry.pass;
      if (entry.duration_ms !== undefined) fields.duration_ms = entry.duration_ms;
      if (entry.output_preview !== undefined) fields.output_preview = String(entry.output_preview).slice(0, 500);
      break;

    case "orch.decision":
      if (entry.decision !== undefined) fields.decision = entry.decision;
      if (entry.reason !== undefined) fields.reason = entry.reason;
      if (entry.context !== undefined) fields.context = entry.context;
      break;
  }

  return fields;
}

/** Resolve the trace directory -- reads env at call time for testability. */
export function getTraceDir(): string {
  return process.env.MAE_TRACE_DIR ?? TRACE_DIR;
}

export function createTraceRecorder(traceDirOverride?: string): LogSink {
  const traceDir = traceDirOverride ?? getTraceDir();

  // Ensure trace directory exists
  if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true });

  // Track current session file
  let currentSessionId: string | null = null;
  let currentFile: string | null = null;

  return {
    write(entry: LogEntry): void {
      const sessionId = entry.session_id as string | undefined;
      if (!sessionId) return; // Only record session-scoped events

      // Open new trace file when session starts
      if (sessionId !== currentSessionId) {
        currentSessionId = sessionId;
        currentFile = join(traceDir, `${sessionId}.jsonl`);
      }

      if (!currentFile) return;

      const traceType = mapLogToTraceType(entry);

      // Build trace event from log entry
      const traceEvent = {
        ts: entry.ts,
        type: traceType,
        id: crypto.randomUUID(),
        parent_id: entry.parent_id as string | undefined,
        session_id: sessionId,
        ...extractTraceFields(entry, traceType),
      };

      appendFileSync(currentFile, JSON.stringify(traceEvent) + "\n");
    },

    async flush(): Promise<void> {
      // appendFileSync is synchronous, nothing to flush
    },

    async close(): Promise<void> {
      currentSessionId = null;
      currentFile = null;
    },
  };
}
