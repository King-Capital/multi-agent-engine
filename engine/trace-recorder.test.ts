import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createTraceRecorder } from "./trace-recorder";
import type { LogEntry } from "./logger";

const TEST_TRACE_DIR = join(import.meta.dir, "..", ".test-traces-" + process.pid);

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: new Date().toISOString(),
    level: "INFO",
    component: "orchestrator",
    msg: "Test message",
    ...overrides,
  };
}

describe("trace-recorder", () => {
  beforeEach(() => {
    if (existsSync(TEST_TRACE_DIR)) rmSync(TEST_TRACE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_TRACE_DIR)) rmSync(TEST_TRACE_DIR, { recursive: true });
  });

  test("creates trace directory if it does not exist", () => {
    expect(existsSync(TEST_TRACE_DIR)).toBe(false);
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    expect(existsSync(TEST_TRACE_DIR)).toBe(true);
    recorder.close?.();
  });

  test("session-scoped events produce a JSONL file named {session_id}.jsonl", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-session-abc";

    recorder.write(makeEntry({
      session_id: sessionId,
      msg: "Session started",
      component: "orchestrator",
    }));

    const expectedFile = join(TEST_TRACE_DIR, `${sessionId}.jsonl`);
    expect(existsSync(expectedFile)).toBe(true);
    recorder.close?.();
  });

  test("non-session events are ignored (no file created)", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);

    recorder.write(makeEntry({ msg: "No session here" }));
    // No session_id => no file
    const files = readdirSync(TEST_TRACE_DIR);
    expect(files).toHaveLength(0);
    recorder.close?.();
  });

  test("each line in the trace file is valid JSON", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-json-validity";

    recorder.write(makeEntry({ session_id: sessionId, msg: "Session started" }));
    recorder.write(makeEntry({ session_id: sessionId, msg: "Some work" }));
    recorder.write(makeEntry({ session_id: sessionId, msg: "Session ended" }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(3);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    recorder.close?.();
  });

  test("trace events have required fields: ts, type, id, session_id", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-required-fields";

    recorder.write(makeEntry({ session_id: sessionId, msg: "Session started" }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const event = JSON.parse(content.trim());

    expect(event.ts).toBeDefined();
    expect(typeof event.ts).toBe("string");
    expect(event.type).toBeDefined();
    expect(typeof event.type).toBe("string");
    expect(event.id).toBeDefined();
    expect(typeof event.id).toBe("string");
    expect(event.session_id).toBe(sessionId);
    recorder.close?.();
  });

  test("multiple sessions produce separate files", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);

    recorder.write(makeEntry({ session_id: "session-1", msg: "Session started" }));
    recorder.write(makeEntry({ session_id: "session-2", msg: "Session started" }));

    expect(existsSync(join(TEST_TRACE_DIR, "session-1.jsonl"))).toBe(true);
    expect(existsSync(join(TEST_TRACE_DIR, "session-2.jsonl"))).toBe(true);

    const content1 = readFileSync(join(TEST_TRACE_DIR, "session-1.jsonl"), "utf-8").trim();
    const content2 = readFileSync(join(TEST_TRACE_DIR, "session-2.jsonl"), "utf-8").trim();

    const event1 = JSON.parse(content1);
    const event2 = JSON.parse(content2);

    expect(event1.session_id).toBe("session-1");
    expect(event2.session_id).toBe("session-2");
    recorder.close?.();
  });

  test("maps orchestrator 'Session started' to session.start type", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-session-start";

    recorder.write(makeEntry({
      session_id: sessionId,
      component: "orchestrator",
      msg: "Session started",
      name: "My Session",
      chain: "plan-build-review",
    }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const event = JSON.parse(content.trim());

    expect(event.type).toBe("session.start");
    expect(event.goal).toBe("My Session");
    expect(event.chain).toBe("plan-build-review");
    recorder.close?.();
  });

  test("maps orchestrator 'Session ended' to session.end type", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-session-end";

    recorder.write(makeEntry({
      session_id: sessionId,
      component: "orchestrator",
      msg: "Session ended",
      status: "completed",
      cost_usd: 1.23,
    }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const event = JSON.parse(content.trim());

    expect(event.type).toBe("session.end");
    expect(event.status).toBe("completed");
    expect(event.total_cost).toBe(1.23);
    recorder.close?.();
  });

  test("maps chain-runner step events to chain.step types", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-chain-steps";

    recorder.write(makeEntry({
      session_id: sessionId,
      component: "chain-runner",
      msg: "Step 1 starting: build",
      step: 1,
      name: "build",
      team: "engineering",
    }));

    recorder.write(makeEntry({
      session_id: sessionId,
      component: "chain-runner",
      msg: "Step 1 completed",
      step: 1,
      name: "build",
      status: "completed",
    }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const lines = content.trim().split("\n");
    const startEvent = JSON.parse(lines[0]!);
    const endEvent = JSON.parse(lines[1]!);

    expect(startEvent.type).toBe("chain.step.start");
    expect(startEvent.step).toBe(1);
    expect(startEvent.name).toBe("build");
    expect(startEvent.step_name).toBe("build");
    expect(endEvent.type).toBe("chain.step.end");
    expect(endEvent.name).toBe("build");
    recorder.close?.();
  });

  test("honors explicit trace_type over message heuristics", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-explicit-step";

    recorder.write(makeEntry({
      session_id: sessionId,
      component: "chain-runner",
      msg: "Lifecycle marker",
      trace_type: "chain.step.end",
      step: 2,
      name: "verify",
      status: "failed",
      reason: "deterministic check failed",
    }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const event = JSON.parse(content.trim());

    expect(event.type).toBe("chain.step.end");
    expect(event.name).toBe("verify");
    expect(event.status).toBe("failed");
    expect(event.reason).toBe("deterministic check failed");
    recorder.close?.();
  });

  test("preserves bounded step failure metadata", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-step-failure";

    recorder.write(makeEntry({
      session_id: sessionId,
      component: "chain-runner",
      msg: "Step 2 failed",
      trace_type: "chain.step.end",
      step: 2,
      name: "verify",
      status: "failed",
      error_type: "Error",
      error_preview: "x".repeat(600),
    }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const event = JSON.parse(content.trim());

    expect(event.type).toBe("chain.step.end");
    expect(event.error_type).toBe("Error");
    expect(event.error_preview).toHaveLength(500);
    recorder.close?.();
  });

  test("records participant lifecycle and heartbeat fields", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-participants";

    recorder.write(makeEntry({
      session_id: sessionId,
      component: "event-emitter",
      msg: "Participant event",
      trace_type: "participant.start",
      agent_id: "pi-correctness-lead",
      participant_id: "pi-correctness-lead",
      name: "Correctness Lead",
      kind: "lead",
      status: "active",
      role: "lead",
      team: "Correctness Review",
      model: "gpt-5.5",
      capabilities: { canUseTools: true, tools: ["read"] },
    }));
    recorder.write(makeEntry({
      session_id: sessionId,
      component: "event-emitter",
      msg: "Participant event",
      trace_type: "participant.heartbeat",
      agent_id: "pi-correctness-lead",
      participant_id: "pi-correctness-lead",
      status: "active",
      current_tool: "read",
      last_event: "tool_call",
      cost_usd: 0.12,
      tokens_used: 42,
    }));
    recorder.write(makeEntry({
      session_id: sessionId,
      component: "event-emitter",
      msg: "Participant event",
      trace_type: "participant.stale",
      agent_id: "pi-correctness-lead",
      participant_id: "pi-correctness-lead",
      status: "stale",
      reason: "no activity for 60s",
    }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const events = content.trim().split("\n").map((line) => JSON.parse(line));

    expect(events.map((event: { type: string }) => event.type)).toEqual(["participant.start", "participant.heartbeat", "participant.stale"]);
    expect(events[0]!.participant_id).toBe("pi-correctness-lead");
    expect(events[0]!.capabilities.tools).toEqual(["read"]);
    expect(events[1]!.current_tool).toBe("read");
    expect(events[1]!.tokens_used).toBe(42);
    expect(events[2]!.status).toBe("stale");
    recorder.close?.();
  });

  test("stores agent output artifact metadata without full output", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-agent-output";

    recorder.write(makeEntry({
      session_id: sessionId,
      component: "pi-adapter",
      msg: "Agent completed",
      trace_type: "agent.end",
      output_preview: "short preview",
      output_hash: "abc123",
      output_artifact: `${sessionId}/artifacts/agent-output-abc123.txt`,
      output_bytes: 1234,
    }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const event = JSON.parse(content.trim());

    expect(event.type).toBe("agent.end");
    expect(event.output_preview).toBe("short preview");
    expect(event.output_hash).toBe("abc123");
    expect(event.output_artifact).toBe(`${sessionId}/artifacts/agent-output-abc123.txt`);
    expect(event.output_bytes).toBe(1234);
    expect(event.output).toBeUndefined();
    recorder.close?.();
  });

  test("bounds step reason metadata", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-step-reason";

    recorder.write(makeEntry({
      session_id: sessionId,
      component: "chain-runner",
      msg: "Step 3 skipped",
      trace_type: "chain.step.end",
      step: 3,
      name: "review",
      status: "skipped",
      reason: "x".repeat(600),
    }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const event = JSON.parse(content.trim());

    expect(event.type).toBe("chain.step.end");
    expect(event.reason).toHaveLength(500);
    recorder.close?.();
  });

  test("unmapped events default to 'log' type", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);
    const sessionId = "test-generic-log";

    recorder.write(makeEntry({
      session_id: sessionId,
      component: "some-module",
      msg: "Something happened",
    }));

    const content = readFileSync(join(TEST_TRACE_DIR, `${sessionId}.jsonl`), "utf-8");
    const event = JSON.parse(content.trim());

    expect(event.type).toBe("log");
    recorder.close?.();
  });

  test("close resets internal state", async () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);

    recorder.write(makeEntry({ session_id: "s1", msg: "test" }));
    await recorder.close?.();

    // After close, writing a new session should still work
    recorder.write(makeEntry({ session_id: "s2", msg: "test" }));
    expect(existsSync(join(TEST_TRACE_DIR, "s2.jsonl"))).toBe(true);
  });

  test("events interleaved across sessions go to correct files", () => {
    const recorder = createTraceRecorder(TEST_TRACE_DIR);

    recorder.write(makeEntry({ session_id: "s-a", msg: "First in A" }));
    recorder.write(makeEntry({ session_id: "s-b", msg: "First in B" }));
    recorder.write(makeEntry({ session_id: "s-a", msg: "Second in A" }));

    const contentA = readFileSync(join(TEST_TRACE_DIR, "s-a.jsonl"), "utf-8").trim().split("\n");
    const contentB = readFileSync(join(TEST_TRACE_DIR, "s-b.jsonl"), "utf-8").trim().split("\n");

    expect(contentA).toHaveLength(2);
    expect(contentB).toHaveLength(1);

    expect(JSON.parse(contentA[0]!).msg).toBe("First in A");
    expect(JSON.parse(contentA[1]!).msg).toBe("Second in A");
    expect(JSON.parse(contentB[0]!).msg).toBe("First in B");
    recorder.close?.();
  });
});
