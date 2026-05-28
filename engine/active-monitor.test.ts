import { describe, test, expect, beforeEach } from "bun:test";
import { ActiveMonitor, type ActiveMonitorOpts } from "./active-monitor";
import type { AgentActivity } from "./monitoring";
import { IDLE_WARN_MS } from "./monitoring";
import type { BudgetState } from "./budget";
import type { SessionState } from "./types";

function mockEmitter() {
  const calls: { method: string; args: unknown[] }[] = [];
  const handler = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return Promise.resolve();
  };
  return {
    calls,
    stallDetected: handler("stallDetected"),
    nudgeSent: handler("nudgeSent"),
    budgetWarning: handler("budgetWarning"),
    participantHeartbeat: handler("participantHeartbeat"),
    participantStale: handler("participantStale"),
    autoPause: handler("autoPause"),
    message: handler("message"),
  } as any;
}

function mockSession(overrides?: Partial<SessionState>): SessionState {
  return {
    id: "test-session",
    name: "Test",
    chain: "test-chain",
    task: "Test task",
    workingDir: "/tmp",
    status: "active",
    agents: new Map(),
    tillDone: [],
    events: [],
    totalCost: 0,
    totalTokens: 0,
    startedAt: new Date(),
    ...overrides,
  };
}

function mockBudgetState(overrides?: Partial<BudgetState["budgets"]>): BudgetState {
  return {
    budgets: {
      max_per_session_usd: 50,
      warn_at_usd: 25,
      max_per_agent_usd: 15,
      max_total_tokens: 10_000_000,
      budget_action: "pause",
      ...overrides,
    },
    budgetWarned: false,
  };
}

function makeActivity(id: string, name: string, role: string, idleMs: number): AgentActivity {
  return {
    agentId: id,
    name,
    role,
    lastEventAt: Date.now() - idleMs,
    toolCalls: 5,
    lastTool: "Read",
    warned: false,
  };
}

describe("ActiveMonitor", () => {
  let agentActivity: Map<string, AgentActivity>;
  let emitter: ReturnType<typeof mockEmitter>;
  let session: SessionState;
  let budgetState: BudgetState;
  let messageSenders: Map<string, (msg: string) => void>;
  let autoPauseReason: string | null;

  beforeEach(() => {
    agentActivity = new Map();
    emitter = mockEmitter();
    session = mockSession();
    budgetState = mockBudgetState();
    messageSenders = new Map();
    autoPauseReason = null;
  });

  function createMonitor(overrides?: Partial<ActiveMonitorOpts>) {
    return new ActiveMonitor({
      agentActivity,
      session,
      budgetState,
      emitter,
      messageSenders,
      onAutoPause: (reason) => { autoPauseReason = reason; },
      ...overrides,
    });
  }

  test("detects stall after IDLE_WARN_MS", () => {
    const m = createMonitor();
    agentActivity.set("agent-1", makeActivity("agent-1", "Scout", "worker", IDLE_WARN_MS + 1000));

    m.runTick();

    const stallEvents = emitter.calls.filter((c: { method: string }) => c.method === "stallDetected");
    const staleEvents = emitter.calls.filter((c: { method: string }) => c.method === "participantStale");
    expect(stallEvents.length).toBe(1);
    expect(stallEvents[0].args[2]).toBe("Scout");
    expect(staleEvents.length).toBe(1);
    expect(staleEvents[0].args[1]).toBe("agent-1");
  });

  test("does not stall for active agents", () => {
    const m = createMonitor();
    agentActivity.set("agent-1", makeActivity("agent-1", "Scout", "worker", 5000));

    m.runTick();

    const stallEvents = emitter.calls.filter((c: { method: string }) => c.method === "stallDetected");
    expect(stallEvents.length).toBe(0);
  });

  test("emits participant heartbeats with status and current tool", () => {
    const m = createMonitor();
    agentActivity.set("agent-1", makeActivity("agent-1", "Scout", "worker", 5000));

    m.runTick();
    m.runTick();

    const heartbeats = emitter.calls.filter((c: { method: string }) => c.method === "participantHeartbeat");
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]?.args).toEqual([
      "test-session",
      "agent-1",
      { status: "active", currentTool: "Read", lastEvent: "heartbeat" },
    ]);
  });

  test("marks idle heartbeat status before escalating to stale", () => {
    const m = createMonitor();
    agentActivity.set("agent-1", makeActivity("agent-1", "Scout", "worker", IDLE_WARN_MS + 5000));

    m.runTick();
    emitter.calls.length = 0;
    m.runTick();

    const heartbeats = emitter.calls.filter((c: { method: string }) => c.method === "participantHeartbeat");
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]?.args).toEqual([
      "test-session",
      "agent-1",
      { status: "idle", currentTool: "Read", lastEvent: "idle_heartbeat" },
    ]);
  });

  test("sends nudge on stalled agent", async () => {
    const sentMessages: string[] = [];
    messageSenders.set("test-session:agent-1", (msg) => sentMessages.push(msg));

    const m = createMonitor();
    const activity = makeActivity("agent-1", "Builder", "worker", IDLE_WARN_MS + 5000);
    activity.warned = true;
    agentActivity.set("agent-1", activity);

    m.runTick();
    // Let the async nudge complete
    await Bun.sleep(100);

    const nudgeEvents = emitter.calls.filter((c: { method: string }) => c.method === "nudgeSent");
    expect(nudgeEvents.length).toBe(1);
    expect(sentMessages.length).toBe(1);
  });

  test("resets nudge state when agent resumes", () => {
    const m = createMonitor();
    const activity = makeActivity("agent-1", "Scout", "worker", IDLE_WARN_MS + 1000);
    agentActivity.set("agent-1", activity);

    m.runTick();
    expect(emitter.calls.filter((c: { method: string }) => c.method === "stallDetected").length).toBe(1);

    // Simulate agent resuming
    activity.lastEventAt = Date.now();
    activity.warned = false;
    emitter.calls.length = 0;

    m.runTick();

    const stallsAfterResume = emitter.calls.filter((c: { method: string }) => c.method === "stallDetected");
    expect(stallsAfterResume.length).toBe(0);
  });

  test("auto-pauses on budget threshold", () => {
    session.totalCost = 48;
    session.startedAt = new Date(Date.now() - 60_000);

    const m = createMonitor();
    m.runTick();

    expect(autoPauseReason).toBe("budget");
    const pauseEvents = emitter.calls.filter((c: { method: string }) => c.method === "autoPause");
    expect(pauseEvents.length).toBe(1);
  });

  test("respects budget_action=warn (no auto-pause)", () => {
    budgetState.budgets!.budget_action = "warn";
    session.totalCost = 48;
    session.startedAt = new Date(Date.now() - 60_000);

    const m = createMonitor();
    m.runTick();

    expect(autoPauseReason).toBeNull();
    const pauseEvents = emitter.calls.filter((c: { method: string }) => c.method === "autoPause");
    expect(pauseEvents.length).toBe(0);
  });

  test("emits budget warning at 80%", () => {
    session.totalCost = 42;
    session.startedAt = new Date(Date.now() - 60_000);

    const m = createMonitor();
    m.runTick();

    const warnings = emitter.calls.filter((c: { method: string }) => c.method === "budgetWarning");
    expect(warnings.length).toBe(1);
  });

  test("stop clears agent activity", () => {
    const m = createMonitor();
    agentActivity.set("a1", makeActivity("a1", "Scout", "worker", 0));
    m.start();
    m.stop();
    expect(agentActivity.size).toBe(0);
  });

  test("only fires auto-pause once", () => {
    session.totalCost = 48;
    session.startedAt = new Date(Date.now() - 60_000);

    const m = createMonitor();
    m.runTick();
    m.runTick();
    m.runTick();

    const pauseEvents = emitter.calls.filter((c: { method: string }) => c.method === "autoPause");
    expect(pauseEvents.length).toBe(1);
  });
});
