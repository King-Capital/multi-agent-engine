import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLangfuseSink } from "./langfuse-sink";
import type { LogEntry } from "./logger";

const originalFetch = globalThis.fetch;
const originalWrite = process.stderr.write;

interface FetchCall {
  url: string;
  body: any;
}

let fetchCalls: FetchCall[] = [];
let shouldThrow = false;
let stderrOutput: string[] = [];

function entry(msg: string, fields: Record<string, unknown> = {}): LogEntry {
  return {
    ts: "2026-05-12T12:00:00.000Z",
    level: "INFO",
    component: "test",
    msg,
    ...fields,
  };
}

function makeSink() {
  return createLangfuseSink({
    publicKey: "pk-test",
    secretKey: "sk-test",
    host: "http://langfuse.test",
    flushIntervalMs: 60_000,
  });
}

function ingestionBatches(): any[] {
  return fetchCalls
    .filter((call) => call.url.endsWith("/api/public/ingestion"))
    .flatMap((call) => call.body.batch);
}

function scoreCalls(): FetchCall[] {
  return fetchCalls.filter((call) => call.url.endsWith("/api/public/scores"));
}

beforeEach(() => {
  fetchCalls = [];
  shouldThrow = false;
  stderrOutput = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (shouldThrow) throw new Error("network down");
    fetchCalls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrOutput.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stderr.write = originalWrite;
});

describe("langfuse sink", () => {
  test("trace-create includes userId, environment, release, tags, and structured input/output", async () => {
    const sink = makeSink();
    sink.write(entry("Session started", {
      session_id: "session-1",
      name: "Build feature",
      task: "Create a feature",
      chain: "build-verify",
      adapter: "echo",
      initiator: "rico",
    }));
    sink.write(entry("Session ended", {
      session_id: "session-1",
      status: "completed",
      cost_usd: 0.25,
      duration_ms: 1234,
      steps_completed: 2,
      steps_total: 2,
      agents_used: 3,
    }));

    await sink.flush?.();
    await sink.close?.();

    const events = ingestionBatches();
    const start = events.find((event) => event.type === "trace-create" && event.body.input);
    const end = events.find((event) => event.type === "trace-create" && event.body.output);
    expect(start.body.userId).toBe("rico");
    expect(start.body.environment).toBe("development");
    expect(start.body.release).toBe("1.0.4");
    expect(start.body.tags).toEqual(["build-verify", "echo"]);
    expect(start.body.input).toEqual({
      goal: "Build feature",
      task: "Create a feature",
      chain: "build-verify",
    });
    expect(end.body.output).toEqual({
      status: "completed",
      cost_usd: 0.25,
      duration_ms: 1234,
      steps_completed: 2,
      steps_total: 2,
      agents_used: 3,
      errors: 0,
    });
  });

  test("llm.call creates a generation with usage and parent agent span", async () => {
    const sink = makeSink();
    sink.write(entry("Session started", { session_id: "session-1", name: "Test session" }));
    sink.write(entry("Spawning pi-rpc agent", {
      trace_type: "agent.start",
      session_id: "session-1",
      agent_id: "agent-1",
      persona: "Builder",
      model: "claude-sonnet-4.6",
      team: "Engineering",
    }));
    sink.write(entry("LLM call completed", {
      trace_type: "llm.call",
      session_id: "session-1",
      agent_id: "agent-1",
      persona: "Builder",
      model: "claude-sonnet-4.6",
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      cache_read_tokens: 10,
      cost: 0.003,
      prompt_name: "mae-agent/builder",
      prompt_version: "abc123",
      prompt_hash: "abc123def456",
      prompt_context_repo: "multi-agent-engine",
      prompt_context_root: "/tmp/multi-agent-engine",
      prompt_context_stack: "bun",
    }));

    await sink.flush?.();
    await sink.close?.();

    const events = ingestionBatches();
    const agentSpan = events.find((event) => event.type === "span-create" && event.body.name === "Builder");
    const generation = events.find((event) => event.type === "generation-create");
    expect(generation).toBeDefined();
    expect(generation.body.parentObservationId).toBe(agentSpan.body.id);
    expect(generation.body.model).toBe("claude-sonnet-4.6");
    expect(generation.body.promptName).toBe("mae-agent/builder");
    expect(generation.body.promptVersion).toBe("abc123");
    expect(generation.body.usage).toEqual({
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
    });
    expect(generation.body.metadata.cost_usd).toBe(0.003);
    expect(generation.body.metadata.cache_read_tokens).toBe(10);
    expect(generation.body.metadata.prompt_hash).toBe("abc123def456");
    expect(generation.body.metadata.prompt_context_repo).toBe("multi-agent-engine");
    expect(generation.body.metadata.prompt_context_stack).toBe("bun");
  });

  test("tool.call creates tool spans and agent.end updates the parent span", async () => {
    const sink = makeSink();
    sink.write(entry("Session started", { session_id: "session-1", name: "Test session" }));
    sink.write(entry("Spawning pi-rpc agent", {
      trace_type: "agent.start",
      session_id: "session-1",
      agent_id: "agent-1",
      persona: "Builder",
    }));
    sink.write(entry("Tool call", {
      trace_type: "tool.call",
      session_id: "session-1",
      agent_id: "agent-1",
      tool: "read",
      args_preview: "engine/file.ts",
    }));
    sink.write(entry("Tool call completed", {
      trace_type: "tool.call",
      session_id: "session-1",
      agent_id: "agent-1",
      tool: "read",
      success: true,
      output_preview: "ok",
    }));
    sink.write(entry("Agent completed", {
      trace_type: "agent.end",
      session_id: "session-1",
      agent_id: "agent-1",
      grade: "VERIFIED",
      cost: 0.01,
      tokens: 200,
      output_preview: "done",
    }));

    await sink.flush?.();
    await sink.close?.();

    const events = ingestionBatches();
    const agentSpan = events.find((event) => event.type === "span-create" && event.body.name === "Builder");
    const toolSpans = events.filter((event) => event.type === "span-create" && event.body.name === "tool/read");
    const spanUpdate = events.find((event) => event.type === "span-update");
    expect(toolSpans).toHaveLength(2);
    expect(toolSpans[0]!.body.parentObservationId).toBe(agentSpan.body.id);
    expect(toolSpans[0]!.body.input).toBe("engine/file.ts");
    expect(toolSpans[1]!.body.output).toBe("ok");
    expect(spanUpdate.body.id).toBe(agentSpan.body.id);
    expect(spanUpdate.body.endTime).toBe("2026-05-12T12:00:00.000Z");
    expect(spanUpdate.body.output).toEqual({
      grade: "VERIFIED",
      output_preview: "done",
      cost_usd: 0.01,
      tokens: 200,
    });
  });

  test("session end posts deterministic scores and skips scores with missing fields", async () => {
    const sink = makeSink();
    sink.write(entry("Session started", { session_id: "session-1", name: "Test session" }));
    sink.write(entry("Session ended", {
      session_id: "session-1",
      status: "completed",
      cost_usd: 2,
      budget_limit: 10,
      successful_workers: 3,
      total_workers: 4,
      steps_completed: 2,
      steps_total: 5,
    }));

    await sink.flush?.();
    await sink.close?.();

    const scores = scoreCalls().map((call) => call.body);
    expect(scores).toEqual([
      { name: "session_completion", traceId: "session-1", value: 1, comment: "Session ended with status completed." },
      { name: "cost_efficiency", traceId: "session-1", value: 0.8, comment: "Cost $2.0000 against $10.0000 budget." },
      { name: "worker_success_rate", traceId: "session-1", value: 0.75, comment: "3/4 workers succeeded." },
      { name: "chain_step_completion", traceId: "session-1", value: 0.4, comment: "2/5 chain steps completed." },
    ]);

    fetchCalls = [];
    const sinkWithMissingFields = makeSink();
    sinkWithMissingFields.write(entry("Session started", { session_id: "session-2", name: "No scores" }));
    sinkWithMissingFields.write(entry("Session ended", { session_id: "session-2" }));
    await sinkWithMissingFields.flush?.();
    await sinkWithMissingFields.close?.();
    expect(scoreCalls()).toHaveLength(0);
  });

  test("flush degrades gracefully when Langfuse ingestion and score APIs fail", async () => {
    shouldThrow = true;
    const sink = makeSink();
    sink.write(entry("Session started", { session_id: "session-1", name: "Test session" }));
    sink.write(entry("Session ended", { session_id: "session-1", status: "completed" }));

    await expect(sink.flush?.()).resolves.toBeUndefined();
    await expect(sink.close?.()).resolves.toBeUndefined();
    expect(stderrOutput.join("")).toContain("[langfuse-sink]");
  });
});
