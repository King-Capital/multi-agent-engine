import { describe, test, expect, afterEach } from "bun:test";
import { OrchestratorLoop, type OrchestratorLoopOpts } from "./orchestrator-loop";
import type { SessionState, PlatformAdapter, DelegateOptions, OrchestratorAction } from "./types";
import type { BudgetState } from "./budget";

// --- Helpers ---

function createSpy() {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => { calls.push(args); return Promise.resolve(); };
  return { fn, calls };
}

function mockAdapter(output: string, delayMs = 0): PlatformAdapter & { delegateCalls: DelegateOptions[] } {
  const delegateCalls: DelegateOptions[] = [];
  return {
    name: "mock",
    delegateCalls,
    async delegate(opts: DelegateOptions) {
      delegateCalls.push(opts);
      if (delayMs > 0) await Bun.sleep(delayMs);
      return { agentId: "orch-loop", agentName: "Orchestrator", output, costUsd: 0.01, tokensUsed: 100, grade: "VERIFIED" as const };
    },
    async isAvailable() { return true; },
  };
}

function mockEmitter() {
  const sessionStateSpy = createSpy();
  const messageSpy = createSpy();
  const costUpdateSpy = createSpy();
  return {
    sessionState: sessionStateSpy.fn,
    message: messageSpy.fn,
    costUpdate: costUpdateSpy.fn,
    sessionStateCalls: sessionStateSpy.calls,
    messageCalls: messageSpy.calls,
    costUpdateCalls: costUpdateSpy.calls,
  } as any;
}

function mockSession(): SessionState {
  return {
    id: "test-session",
    name: "Test",
    chain: "plan-build-review",
    task: "Build a feature",
    workingDir: "/tmp/test",
    status: "active",
    agents: new Map(),
    tillDone: [
      { description: "plan", completed: true, active: false, type: "llm_verified" as const },
      { description: "build", completed: false, active: true, type: "llm_verified" as const },
      { description: "review", completed: false, active: false, type: "llm_verified" as const },
    ],
    events: [],
    totalCost: 0.5,
    totalTokens: 5000,
    startedAt: new Date(),
  };
}

function mockBudget(): BudgetState {
  return { budgets: { max_per_session_usd: 50, warn_at_usd: 25, max_per_agent_usd: 15, max_total_tokens: 10_000_000, budget_action: "pause" }, budgetWarned: false };
}

function createLoop(adapterOutput: string, overrides?: Partial<OrchestratorLoopOpts>) {
  const adapter = mockAdapter(adapterOutput);
  const emitter = mockEmitter();
  const actionQueue: OrchestratorAction[] = [];
  const session = mockSession();
  const opts: OrchestratorLoopOpts = {
    session,
    adapter,
    emitter,
    budgetState: mockBudget(),
    pausedSessions: new Set(),
    messageBuffers: new Map(),
    actionQueue,
    intervalMs: 100_000,
    ...overrides,
  };
  const loop = new OrchestratorLoop(opts);
  return { loop, adapter, emitter, actionQueue, session, opts };
}

// --- Tests ---

describe("OrchestratorLoop", () => {
  let activeLoop: OrchestratorLoop | null = null;

  afterEach(() => {
    activeLoop?.stop();
    activeLoop = null;
  });

  test("parseActions extracts valid CONTINUE action", async () => {
    const { loop, actionQueue } = createLoop(JSON.stringify({
      assessment: "All good",
      actions: [{ type: "CONTINUE" }],
    }));
    activeLoop = loop;
    await loop.handleUserMessage("status?");
    expect(actionQueue.length).toBe(1);
    expect(actionQueue[0]!.type).toBe("CONTINUE");
  });

  test("parseActions extracts PAUSE action with reason", async () => {
    const { loop, actionQueue } = createLoop(JSON.stringify({
      assessment: "Budget critical",
      actions: [{ type: "PAUSE", reason: "budget exceeded" }],
    }));
    activeLoop = loop;
    await loop.handleUserMessage("check");
    expect(actionQueue.length).toBe(1);
    expect(actionQueue[0]!.type).toBe("PAUSE");
    expect((actionQueue[0]! as { type: "PAUSE"; reason: string }).reason).toBe("budget exceeded");
  });

  test("parseActions handles malformed JSON gracefully", async () => {
    const { loop, actionQueue } = createLoop("I don't know what to do");
    activeLoop = loop;
    await loop.handleUserMessage("status");
    expect(actionQueue.length).toBe(1);
    expect(actionQueue[0]!.type).toBe("CONTINUE");
  });

  test("parseActions validates action fields", async () => {
    const { loop, actionQueue } = createLoop(JSON.stringify({
      assessment: "ok",
      actions: [{ type: "REASSIGN" }], // missing required fields
    }));
    activeLoop = loop;
    await loop.handleUserMessage("check");
    expect(actionQueue.length).toBe(1);
    expect(actionQueue[0]!.type).toBe("CONTINUE"); // fallback
  });

  test("ring buffer limits to 50 events", async () => {
    const { loop, adapter } = createLoop(JSON.stringify({
      assessment: "ok", actions: [{ type: "CONTINUE" }],
    }));
    activeLoop = loop;
    for (let i = 0; i < 60; i++) {
      loop.recordEvent({
        session_id: "test-session",
        agent_id: `agent-${i}`,
        event_type: "tool_call",
        timestamp: new Date().toISOString(),
        data: { index: i },
      });
    }
    await loop.handleUserMessage("status");
    const prompt = adapter.delegateCalls[0]!.userPrompt;
    expect(prompt).toContain("last 50");
    expect(prompt).not.toContain("last 60");
  });

  test("debounce prevents rapid cycles", async () => {
    const { loop, adapter } = createLoop(JSON.stringify({
      assessment: "ok", actions: [{ type: "CONTINUE" }],
    }));
    activeLoop = loop;
    // First trigger runs immediately (no debounce yet)
    loop.trigger("agent_done");
    await Bun.sleep(50); // let async cycle complete
    // Second trigger should be debounced
    loop.trigger("stall_detected");
    await Bun.sleep(50);
    expect(adapter.delegateCalls.length).toBe(1);
  });

  test("handleUserMessage bypasses debounce", async () => {
    const { loop, adapter } = createLoop(JSON.stringify({
      assessment: "ok", actions: [{ type: "CONTINUE" }],
    }));
    activeLoop = loop;
    loop.trigger("agent_done");
    await Bun.sleep(50);
    await loop.handleUserMessage("help");
    expect(adapter.delegateCalls.length).toBe(2);
  });

  test("computeProgress from tillDone", async () => {
    const { loop, emitter } = createLoop(JSON.stringify({
      assessment: "ok", actions: [{ type: "CONTINUE" }],
    }));
    activeLoop = loop;
    await loop.handleUserMessage("progress?");
    expect(emitter.sessionStateCalls.length).toBe(1);
    const state = emitter.sessionStateCalls[0][1] as { progress: number };
    expect(state.progress).toBeCloseTo(33.33, 0);
  });

  test("reply is emitted as message", async () => {
    const { loop, emitter } = createLoop(JSON.stringify({
      assessment: "ok",
      actions: [{ type: "CONTINUE" }],
      reply: "Everything is on track",
    }));
    activeLoop = loop;
    await loop.handleUserMessage("how's it going?");
    expect(emitter.messageCalls.length).toBe(1);
    expect(emitter.messageCalls[0][4]).toBe("Everything is on track");
  });

  test("ESCALATE_TO_USER action is parsed correctly", async () => {
    const { loop, actionQueue } = createLoop(JSON.stringify({
      assessment: "Ambiguous task",
      actions: [{ type: "ESCALATE_TO_USER", message: "Need clarification on scope" }],
    }));
    activeLoop = loop;
    await loop.handleUserMessage("proceed");
    expect(actionQueue.length).toBe(1);
    expect(actionQueue[0]!.type).toBe("ESCALATE_TO_USER");
    expect((actionQueue[0]! as { type: "ESCALATE_TO_USER"; message: string }).message).toBe("Need clarification on scope");
  });

  test("stop clears the timer", async () => {
    const { loop, adapter } = createLoop(JSON.stringify({
      assessment: "ok", actions: [{ type: "CONTINUE" }],
    }), { intervalMs: 50 });
    activeLoop = loop;
    loop.start();
    loop.stop();
    await Bun.sleep(150);
    // No periodic cycles should have fired after stop
    expect(adapter.delegateCalls.length).toBe(0);
  });

  test("session cost is tracked", async () => {
    const { loop, session } = createLoop(JSON.stringify({
      assessment: "ok", actions: [{ type: "CONTINUE" }],
    }));
    activeLoop = loop;
    const costBefore = session.totalCost;
    await loop.handleUserMessage("check cost");
    expect(session.totalCost).toBe(costBefore + 0.01);
  });

  test("orchestrator cost is emitted for the orch agent", async () => {
    const { loop, emitter } = createLoop(JSON.stringify({
      assessment: "ok", actions: [{ type: "CONTINUE" }],
    }));
    activeLoop = loop;

    await loop.handleUserMessage("check cost");

    expect(emitter.costUpdateCalls).toEqual([
      ["test-session", "orch-1", 0.01, 100, 0],
    ]);
    expect(loop.getCostSummary()).toEqual({ costUsd: 0.01, tokensUsed: 100 });
  });

  test("stopAndDrain waits for in-flight orchestrator cost", async () => {
    const adapter = mockAdapter(JSON.stringify({
      assessment: "ok", actions: [{ type: "CONTINUE" }],
    }), 50);
    const { loop } = createLoop("unused", { adapter });
    activeLoop = loop;

    const cycle = loop.handleUserMessage("check cost");
    await Bun.sleep(10);
    const summary = await loop.stopAndDrain(500);
    await cycle;

    expect(summary).toEqual({ costUsd: 0.01, tokensUsed: 100 });
  });
});
