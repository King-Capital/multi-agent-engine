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

    // Should not throw
    checkBudget(state, session, "agent-1", 100, emitter);
    expect(emitter.messages).toHaveLength(0);
  });

  test("does nothing when costs are within limits", () => {
    const state: BudgetState = { budgets: makeBudgets(), budgetWarned: false };
    const session = makeSession({ totalCost: 5 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 2, emitter);
    expect(state.budgetWarned).toBe(false);
    expect(emitter.messages).toHaveLength(0);
  });

  test("sets budgetWarned and emits message at warn threshold", () => {
    const state: BudgetState = { budgets: makeBudgets({ warn_at_usd: 10 }), budgetWarned: false };
    const session = makeSession({ totalCost: 12 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 2, emitter);
    expect(state.budgetWarned).toBe(true);
    expect(emitter.messages).toHaveLength(1);
    expect(emitter.messages[0]!.content).toContain("Budget warning");
  });

  test("does not warn twice once budgetWarned is set", () => {
    const state: BudgetState = { budgets: makeBudgets({ warn_at_usd: 10 }), budgetWarned: true };
    const session = makeSession({ totalCost: 15 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 2, emitter);
    expect(emitter.messages).toHaveLength(0);
  });

  test("throws when session cost exceeds max_per_session_usd", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_per_session_usd: 50 }), budgetWarned: true };
    const session = makeSession({ totalCost: 55 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 5, emitter)).toThrow("Budget exceeded");
  });

  test("throws when token count exceeds max_total_tokens", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_total_tokens: 1_000_000 }), budgetWarned: true };
    const session = makeSession({ totalTokens: 1_500_000 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 1, emitter)).toThrow("Token budget exceeded");
  });

  test("logs warning when agent cost exceeds per-agent limit", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_per_agent_usd: 15 }), budgetWarned: true };
    const session = makeSession({ totalCost: 5 });
    const emitter = makeEmitter();

    // Should not throw, just warn (console.warn)
    checkBudget(state, session, "agent-1", 20, emitter);
    // No emitter message for per-agent warning (only console.warn)
    expect(emitter.messages).toHaveLength(0);
  });

  test("warn and throw can trigger in the same call", () => {
    const state: BudgetState = {
      budgets: makeBudgets({ warn_at_usd: 10, max_per_session_usd: 50 }),
      budgetWarned: false,
    };
    const session = makeSession({ totalCost: 55 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 5, emitter)).toThrow("Budget exceeded");
    // Warning was emitted before the throw
    expect(state.budgetWarned).toBe(true);
    expect(emitter.messages).toHaveLength(1);
  });

  test("handles exact boundary values for warn threshold", () => {
    const state: BudgetState = { budgets: makeBudgets({ warn_at_usd: 10 }), budgetWarned: false };
    const session = makeSession({ totalCost: 10 });
    const emitter = makeEmitter();

    checkBudget(state, session, "agent-1", 2, emitter);
    expect(state.budgetWarned).toBe(true);
  });

  test("handles exact boundary for session limit", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_per_session_usd: 50 }), budgetWarned: true };
    const session = makeSession({ totalCost: 50 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 1, emitter)).toThrow("Budget exceeded");
  });

  test("handles exact boundary for token limit", () => {
    const state: BudgetState = { budgets: makeBudgets({ max_total_tokens: 1_000_000 }), budgetWarned: true };
    const session = makeSession({ totalTokens: 1_000_000 });
    const emitter = makeEmitter();

    expect(() => checkBudget(state, session, "agent-1", 1, emitter)).toThrow("Token budget exceeded");
  });
});
