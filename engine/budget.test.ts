import { test, expect, describe } from "bun:test";
import { checkBudget } from "./budget";
import type { BudgetState, BudgetLimits } from "./budget";
import type { SessionState } from "./types";

function makeSession(overrides?: Partial<SessionState>): SessionState {
  return {
    id: "test-session",
    name: "Test",
    chain: "test-chain",
    task: "test task",
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

function makeBudgets(overrides?: Partial<BudgetLimits>): BudgetLimits {
  return {
    max_per_session_usd: 50,
    warn_at_usd: 10,
    max_per_agent_usd: 15,
    max_total_tokens: 10_000_000,
    ...overrides,
  };
}

// Minimal emitter stub that records message calls
function makeEmitter() {
  const messages: { sessionId: string; agentId: string; content: string }[] = [];
  return {
    messages,
    message: (sessionId: string, agentId: string, _name: string, _role: string, content: string) => {
      messages.push({ sessionId, agentId, content });
    },
  } as any;
}

describe("checkBudget", () => {
  test("does nothing when budgets are null", () => {
    const state: BudgetState = { budgets: null, budgetWarned: false };
    const session = makeSession({ totalCost: 999 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 100, 0, emitter);
    expect(emitter.messages).toHaveLength(0);
  });

  test("does nothing when projected costs are within limits", () => {
    const state: BudgetState = { budgets: makeBudgets(), budgetWarned: false };
    const session = makeSession({ totalCost: 5 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 2, 1000, emitter);
    expect(state.budgetWarned).toBe(false);
    expect(emitter.messages).toHaveLength(0);
  });

  test("sets budgetWarned and emits message when projected cost hits warn threshold", () => {
    const state: BudgetState = { budgets: makeBudgets({ warn_at_usd: 10 }), budgetWarned: false };
    const session = makeSession({ totalCost: 8 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 3, 1000, emitter);
    expect(state.budgetWarned).toBe(true);
    expect(emitter.messages).toHaveLength(1);
    expect(emitter.messages[0]!.content).toContain("Budget warning");
  });

  test("does not warn twice once budgetWarned is set", () => {
    const state: BudgetState = { budgets: makeBudgets({ warn_at_usd: 10 }), budgetWarned: true };
    const session = makeSession({ totalCost: 15 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 2, 1000, emitter);
    expect(emitter.messages).toHaveLength(0);
  });

  test("throws when projected session cost exceeds max_per_session_usd", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_per_session_usd: 50 }), budgetWarned: true };
    const session = makeSession({ totalCost: 45 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 6, 1000, emitter)).toThrow("Budget exceeded");
  });

  test("throws when projected token count exceeds max_total_tokens", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_total_tokens: 1_000_000 }), budgetWarned: true };
    const session = makeSession({ totalTokens: 900_000 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 1, 200_000, emitter)).toThrow("Token budget exceeded");
  });

  test("throws when agent cost exceeds per-agent limit", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_per_agent_usd: 15 }), budgetWarned: true };
    const session = makeSession({ totalCost: 5 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 20, 1000, emitter)).toThrow("per-agent limit");
  });

  test("warn and throw can trigger in the same call", () => {
    const state: BudgetState = {
      budgets: makeBudgets({ warn_at_usd: 10, max_per_session_usd: 50 }),
      budgetWarned: false,
    };
    const session = makeSession({ totalCost: 45 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 6, 1000, emitter)).toThrow("Budget exceeded");
    expect(state.budgetWarned).toBe(true);
    expect(emitter.messages).toHaveLength(1);
  });

  test("handles exact boundary values for warn threshold", () => {
    const state: BudgetState = { budgets: makeBudgets({ warn_at_usd: 10 }), budgetWarned: false };
    const session = makeSession({ totalCost: 8 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 2, 1000, emitter);
    expect(state.budgetWarned).toBe(true);
  });

  test("handles exact boundary for session limit", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_per_session_usd: 50 }), budgetWarned: true };
    const session = makeSession({ totalCost: 45 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 5, 1000, emitter)).toThrow("Budget exceeded");
  });

  test("handles exact boundary for token limit", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_total_tokens: 1_000_000 }), budgetWarned: true };
    const session = makeSession({ totalTokens: 900_000 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 1, 100_000, emitter)).toThrow("Token budget exceeded");
  });

  test("does not throw when projected cost is just below session limit", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_per_session_usd: 50 }), budgetWarned: true };
    const session = makeSession({ totalCost: 45 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 4, 1000, emitter);
  });

  test("does not throw when projected tokens are just below limit", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_total_tokens: 1_000_000 }), budgetWarned: true };
    const session = makeSession({ totalTokens: 900_000 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 1, 99_999, emitter);
  });
});
