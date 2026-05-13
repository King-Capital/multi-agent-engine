import { describe, expect, test } from "bun:test";
import { buildStreamHandler } from "./stream-handler";
import type { EventEmitter } from "./event-emitter";
import type { SessionState } from "./types";

function makeSession(status: SessionState["status"]): SessionState {
  return {
    id: "session-1",
    name: "test",
    chain: "test-chain",
    task: "test task",
    workingDir: "/tmp",
    status,
    agents: new Map(),
    tillDone: [],
    events: [],
    totalCost: 0,
    totalTokens: 0,
    startedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function makeEmitter() {
  const events: string[] = [];
  const emitter = {
    severityAlert: () => events.push("severity_alert"),
    autoPause: () => events.push("auto_pause"),
    toolCall: () => events.push("tool_call"),
    costUpdate: () => events.push("cost_update"),
  } as unknown as EventEmitter;

  return { emitter, events };
}

describe("buildStreamHandler", () => {
  test("auto-pauses active sessions on concrete severity findings", () => {
    const { emitter, events } = makeEmitter();
    const pausedSessions = new Set<string>();
    const session = makeSession("active");
    const handler = buildStreamHandler({
      emitter,
      sessionId: session.id,
      agentId: "agent-1",
      trackToolCall: () => {},
      messageSenders: new Map(),
      pausedSessions,
      session,
    });

    handler({ type: "assistant_text", content: "P0: concrete release blocker found" });

    expect(pausedSessions.has(session.id)).toBe(true);
    expect(session.status).toBe("paused");
    expect(events).toEqual(["severity_alert", "auto_pause"]);
  });

  test("does not auto-pause completed sessions from final report text", () => {
    const { emitter, events } = makeEmitter();
    const pausedSessions = new Set<string>();
    const session = makeSession("completed");
    const handler = buildStreamHandler({
      emitter,
      sessionId: session.id,
      agentId: "agent-1",
      trackToolCall: () => {},
      messageSenders: new Map(),
      pausedSessions,
      session,
    });

    handler({ type: "assistant_text", content: "P0: historical issue described in final report" });

    expect(pausedSessions.has(session.id)).toBe(false);
    expect(session.status).toBe("completed");
    expect(events).toEqual([]);
  });
});
