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
  const participantActivities: Array<{ sessionId: string; agentId: string; data: { currentTask?: string; currentTool?: string; lastEvent?: string } }> = [];
  const emitter = {
    severityAlert: () => events.push("severity_alert"),
    autoPause: () => events.push("auto_pause"),
    toolCall: () => events.push("tool_call"),
    costUpdate: () => events.push("cost_update"),
    participantActivity: (sessionId: string, agentId: string, data: { currentTask?: string; currentTool?: string; lastEvent?: string }) => {
      events.push("participant_activity");
      participantActivities.push({ sessionId, agentId, data });
    },
  } as unknown as EventEmitter;

  return { emitter, events, participantActivities };
}

describe("buildStreamHandler", () => {
  test("auto-pauses active sessions on concrete severity findings", () => {
    const { emitter, events, participantActivities } = makeEmitter();
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
    expect(events).toEqual(["participant_activity", "severity_alert", "auto_pause"]);
    expect(participantActivities).toEqual([
      {
        sessionId: "session-1",
        agentId: "agent-1",
        data: { currentTask: "responding", lastEvent: "assistant_text" },
      },
    ]);
  });

  test("does not auto-pause completed sessions from final report text", () => {
    const { emitter, events, participantActivities } = makeEmitter();
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
    expect(events).toEqual(["participant_activity"]);
    expect(participantActivities).toEqual([
      {
        sessionId: "session-1",
        agentId: "agent-1",
        data: { currentTask: "responding", lastEvent: "assistant_text" },
      },
    ]);
  });

  test("does not auto-pause final assistant report text before session completion", () => {
    const { emitter, events, participantActivities } = makeEmitter();
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

    handler({ type: "assistant_text", final: true, content: "CRITICAL\nengine/foo.ts:10\nHistorical finding in final report" });

    expect(pausedSessions.has(session.id)).toBe(false);
    expect(session.status).toBe("active");
    expect(events).toEqual(["participant_activity"]);
    expect(participantActivities).toEqual([
      {
        sessionId: "session-1",
        agentId: "agent-1",
        data: { currentTask: "final_report", lastEvent: "assistant_text_final" },
      },
    ]);
  });
});
