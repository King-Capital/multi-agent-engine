import { test, expect, describe } from "bun:test";
import { buildTillDone, interpolatePrompt, normalizeParallelChain, markTillDone, runChain } from "./chain-runner";
import type { Chain, ChainStep, SessionState, TillDoneItem } from "./types";
import { addSink, clearSinks, type LogEntry } from "./logger";

function makeChain(steps: ChainStep[], overrides?: Partial<Chain>): Chain {
  return { description: "test chain", steps, ...overrides };
}

function makeSession(tillDone: TillDoneItem[]): SessionState {
  return {
    id: "test-1",
    name: "test",
    chain: "test",
    task: "test task",
    workingDir: "/tmp",
    status: "active",
    agents: new Map(),
    tillDone,
    events: [],
    totalCost: 0,
    totalTokens: 0,
    startedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// interpolatePrompt
// ---------------------------------------------------------------------------

describe("interpolatePrompt", () => {
  test("replaces $1 and $2 with positional args", () => {
    expect(interpolatePrompt("Review $1 in $2", ["auth.ts", "src/"])).toBe("Review auth.ts in src/");
  });

  test("leaves unmatched placeholders intact", () => {
    expect(interpolatePrompt("Check $1 and $3", ["file.ts"])).toBe("Check file.ts and $3");
  });

  test("returns original when no placeholders present", () => {
    expect(interpolatePrompt("plain text", ["a", "b"])).toBe("plain text");
  });

  test("returns original with empty args array", () => {
    expect(interpolatePrompt("$1 $2", [])).toBe("$1 $2");
  });

  test("handles $10+ (double digit)", () => {
    const args = Array.from({ length: 10 }, (_, i) => `arg${i + 1}`);
    expect(interpolatePrompt("$10", args)).toBe("arg10");
  });

  test("replaces multiple occurrences of same placeholder", () => {
    expect(interpolatePrompt("$1 and $1", ["x"])).toBe("x and x");
  });
});

// ---------------------------------------------------------------------------
// normalizeParallelChain
// ---------------------------------------------------------------------------

describe("normalizeParallelChain", () => {
  test("converts top-level parallel + then into flat steps", () => {
    const chain = makeChain([], {
      parallel: [{ team: "A" }, { team: "B" }],
      then: [{ team: "Validation" }],
    });
    const steps = normalizeParallelChain(chain);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ parallel: [{ team: "A" }, { team: "B" }] });
    expect(steps[1]).toEqual({ team: "Validation" });
  });

  test("handles parallel only (no then)", () => {
    const chain = makeChain([], {
      parallel: [{ team: "A" }],
    });
    const steps = normalizeParallelChain(chain);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.parallel).toEqual([{ team: "A" }]);
  });

  test("handles then only (no parallel)", () => {
    const chain = makeChain([], {
      then: [{ team: "X" }, { team: "Y" }],
    });
    const steps = normalizeParallelChain(chain);
    expect(steps).toHaveLength(2);
  });

  test("returns empty array when neither parallel nor then", () => {
    const chain = makeChain([]);
    const steps = normalizeParallelChain(chain);
    expect(steps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildTillDone
// ---------------------------------------------------------------------------

describe("buildTillDone", () => {
  test("creates items from string till_done entries", () => {
    const chain = makeChain([
      { team: "Engineering", till_done: ["Code written", "Tests pass"] },
    ]);
    const items = buildTillDone(chain);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ description: "Code written", completed: false, active: true, type: "llm_verified" });
    expect(items[1]).toEqual({ description: "Tests pass", completed: false, active: false, type: "llm_verified" });
  });

  test("creates items from typed till_done entries", () => {
    const chain = makeChain([
      { team: "Validation", till_done: [{ text: "Grade assigned", type: "output_match", verify: "GRADE:\\s*PASS" }] },
    ]);
    const items = buildTillDone(chain);
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("output_match");
    expect(items[0]!.verify).toBe("GRADE:\\s*PASS");
  });

  test("creates default item when step has no till_done", () => {
    const chain = makeChain([{ team: "Engineering" }]);
    const items = buildTillDone(chain);
    expect(items).toHaveLength(1);
    expect(items[0]!.description).toBe("Engineering complete");
  });

  test("creates default item for agent step without till_done", () => {
    const chain = makeChain([{ agent: "Scout" }]);
    const items = buildTillDone(chain);
    expect(items[0]!.description).toBe("Scout complete");
  });

  test("handles empty chain", () => {
    const chain = makeChain([]);
    expect(buildTillDone(chain)).toHaveLength(0);
  });

  test("sets first item active, rest inactive", () => {
    const chain = makeChain([
      { team: "A", till_done: ["step 1"] },
      { team: "B", till_done: ["step 2"] },
    ]);
    const items = buildTillDone(chain);
    expect(items[0]!.active).toBe(true);
    expect(items[1]!.active).toBe(false);
  });

  test("handles mixed steps (team, agent, parallel, deterministic)", () => {
    const chain = makeChain([
      { team: "Planning", till_done: ["Plan done"] },
      { agent: "Scout" },
      { parallel: [{ team: "Red" }, { team: "Blue" }] },
      { deterministic: { command: "echo ok", label: "check" } },
    ]);
    const items = buildTillDone(chain);
    expect(items).toHaveLength(4);
    expect(items[0]!.description).toBe("Plan done");
    expect(items[1]!.description).toBe("Scout complete");
    expect(items[2]!.description).toBe("parallel step complete");
    expect(items[3]!.description).toBe("parallel step complete");
  });

  test("uses steps array when present, ignores parallel/then", () => {
    const chain: Chain = {
      description: "test",
      steps: [{ team: "X", till_done: ["X done"] }],
      parallel: [{ team: "Y" }],
    };
    const items = buildTillDone(chain);
    expect(items).toHaveLength(1);
    expect(items[0]!.description).toBe("X done");
  });
});

// ---------------------------------------------------------------------------
// markTillDone
// ---------------------------------------------------------------------------

describe("markTillDone", () => {
  test("marks items completed up to and including stepIndex", () => {
    const tillDone: TillDoneItem[] = [
      { description: "a", completed: false, active: true, type: "llm_verified" },
      { description: "b", completed: false, active: false, type: "llm_verified" },
      { description: "c", completed: false, active: false, type: "llm_verified" },
    ];
    const session = makeSession(tillDone);
    const steps: ChainStep[] = [
      { team: "A" },
      { team: "B" },
      { team: "C" },
    ];
    markTillDone(session, 1, steps);
    expect(session.tillDone[0]!.completed).toBe(true);
    expect(session.tillDone[1]!.completed).toBe(true);
    expect(session.tillDone[2]!.completed).toBe(false);
    expect(session.tillDone[2]!.active).toBe(true);
  });

  test("handles steps with multiple till_done items", () => {
    const tillDone: TillDoneItem[] = [
      { description: "a1", completed: false, active: true, type: "llm_verified" },
      { description: "a2", completed: false, active: false, type: "llm_verified" },
      { description: "b1", completed: false, active: false, type: "llm_verified" },
    ];
    const session = makeSession(tillDone);
    const steps: ChainStep[] = [
      { team: "A", till_done: ["a1", "a2"] },
      { team: "B", till_done: ["b1"] },
    ];
    markTillDone(session, 0, steps);
    expect(session.tillDone[0]!.completed).toBe(true);
    expect(session.tillDone[1]!.completed).toBe(true);
    expect(session.tillDone[2]!.completed).toBe(false);
    expect(session.tillDone[2]!.active).toBe(true);
  });

  test("handles marking all steps done", () => {
    const tillDone: TillDoneItem[] = [
      { description: "a", completed: false, active: true, type: "llm_verified" },
      { description: "b", completed: false, active: false, type: "llm_verified" },
    ];
    const session = makeSession(tillDone);
    const steps: ChainStep[] = [{ team: "A" }, { team: "B" }];
    markTillDone(session, 1, steps);
    expect(session.tillDone[0]!.completed).toBe(true);
    expect(session.tillDone[1]!.completed).toBe(true);
  });

  test("does not crash with stepIndex beyond array bounds", () => {
    const tillDone: TillDoneItem[] = [
      { description: "a", completed: false, active: true, type: "llm_verified" },
    ];
    const session = makeSession(tillDone);
    const steps: ChainStep[] = [{ team: "A" }];
    markTillDone(session, 5, steps);
    expect(session.tillDone[0]!.completed).toBe(true);
  });

  test("sets active=false on completed items", () => {
    const tillDone: TillDoneItem[] = [
      { description: "a", completed: false, active: true, type: "llm_verified" },
      { description: "b", completed: false, active: false, type: "llm_verified" },
    ];
    const session = makeSession(tillDone);
    markTillDone(session, 0, [{ team: "A" }, { team: "B" }]);
    expect(session.tillDone[0]!.active).toBe(false);
    expect(session.tillDone[1]!.active).toBe(true);
  });
});

describe("runChain trace lifecycle", () => {
  test("marks step trace failed when till_done verification fails", async () => {
    const entries: LogEntry[] = [];
    addSink({ write: (entry) => { entries.push(entry); } });

    try {
      const session = makeSession([
        { description: "must match", completed: false, active: true, type: "output_match", verify: "PASS" },
      ]);
      session.workingDir = import.meta.dir;
      const chain = makeChain([
        {
          deterministic: { command: "printf nope", label: "verify output" },
          till_done: [{ text: "must match", type: "output_match", verify: "PASS" }],
        },
      ]);

      await expect(runChain({
        emitter: {
          message: async () => {},
          tillDone: async () => {},
        },
        messageSenders: new Map(),
        agentActivity: new Map(),
        budgetState: { warned: false },
        pausedSessions: new Set(),
        messageBuffers: new Map(),
        actionQueues: new Map(),
        skippedSteps: new Set(),
        originalStepCount: 0,
        pipelines: new Map(),
        orchestratorLoop: null,
        getAdapter: () => { throw new Error("adapter should not be used"); },
        buildTeamDeps: () => ({} as never),
        drainMessageBuffer: () => "",
      } as never, session, chain, "test task")).rejects.toThrow("Chain step 1 failed");

      const stepEnd = entries.find((entry) => entry.trace_type === "chain.step.end");
      expect(stepEnd?.status).toBe("failed");
      expect(session.tillDone[0]!.completed).toBe(false);
    } finally {
      clearSinks();
    }
  });
});
