import { loadModelRouting } from "./config";
import type { EventEmitter } from "./event-emitter";
import type { SessionState } from "./types";
import { createLogger } from "./logger";

const log = createLogger("budget");

export interface BudgetLimits {
  max_per_session_usd: number;
  warn_at_usd: number;
  max_per_agent_usd: number;
  max_total_tokens: number;
  budget_action?: "warn" | "pause";
}

export interface BudgetProjection {
  currentCost: number;
  projectedCost: number;
  remainingBudget: number;
  percentUsed: number;
  burnRatePerMinute: number;
  willExceed: boolean;
  action: "warn" | "pause";
}

export interface BudgetState {
  budgets: BudgetLimits | null;
  budgetWarned: boolean;
}

/**
 * Load budget limits from model-routing.yaml config.
 * Returns a BudgetState with limits (or null if not configured).
 */
export function loadBudgets(): BudgetState {
  try {
    const budgets = loadModelRouting().budgets ?? null;
    if (budgets) {
      log.info("Limits loaded", { max_per_session_usd: budgets.max_per_session_usd, max_per_agent_usd: budgets.max_per_agent_usd, max_total_tokens_m: Number((budgets.max_total_tokens / 1e6).toFixed(0)) });
    }
    return { budgets, budgetWarned: false };
  } catch (err) {
    log.critical("Failed to load model-routing.yaml -- applying safe defaults", { error: String(err) });
    return {
      budgets: {
        max_per_session_usd: 50.0,
        warn_at_usd: 40.0,
        max_per_agent_usd: 10.0,
        max_total_tokens: 10_000_000,
        budget_action: "pause",
      },
      budgetWarned: false,
    };
  }
}

/**
 * Proactive budget projection called from the monitor loop.
 * Returns projection data and whether the session should be paused.
 */
export function projectBudget(
  budgetState: BudgetState,
  session: SessionState,
): BudgetProjection | null {
  if (!budgetState.budgets) return null;

  const limit = budgetState.budgets.max_per_session_usd;
  const elapsed = (Date.now() - session.startedAt.getTime()) / 1000;
  const burnRate = elapsed > 0 ? (session.totalCost / elapsed) * 60 : 0;
  const percentUsed = (session.totalCost / limit) * 100;

  // Heuristic: assume 50% of elapsed time remains. Conservative for short sessions, reasonable for long ones.
  const estimatedRemainingSec = elapsed > 0 ? elapsed * 0.5 : 300;
  const projectedCost = session.totalCost + (burnRate / 60) * estimatedRemainingSec;

  const action = budgetState.budgets.budget_action ?? "pause";

  return {
    currentCost: session.totalCost,
    projectedCost,
    remainingBudget: limit - session.totalCost,
    percentUsed,
    burnRatePerMinute: burnRate,
    willExceed: projectedCost >= limit,
    action,
  };
}

/**
 * Proactive budget check called from the monitor loop.
 * Emits warnings and signals auto-pause when appropriate.
 */
export function checkBudgetProactive(
  budgetState: BudgetState,
  session: SessionState,
  emitter: EventEmitter,
): { shouldPause: boolean; projection: BudgetProjection | null } {
  const projection = projectBudget(budgetState, session);
  if (!projection) return { shouldPause: false, projection: null };

  if (projection.percentUsed >= 80 && !budgetState.budgetWarned) {
    budgetState.budgetWarned = true;
    emitter.budgetWarning(session.id, projection);
  }

  const shouldPause = projection.percentUsed >= 95 && projection.action === "pause";
  return { shouldPause, projection };
}

/**
 * Check whether the session or agent has exceeded budget limits.
 * Logs warnings and throws on hard limits.
 */
export function checkBudget(
  budgetState: BudgetState,
  session: SessionState,
  agentId: string,
  agentCost: number,
  agentTokens: number,
  emitter: EventEmitter,
): void {
  if (!budgetState.budgets) return;

  const projectedCost = session.totalCost + agentCost;
  const projectedTokens = session.totalTokens + agentTokens;

  if (agentCost > budgetState.budgets.max_per_agent_usd) {
    throw new Error(`Agent ${agentId} exceeded per-agent limit: $${agentCost.toFixed(3)} > $${budgetState.budgets.max_per_agent_usd}`);
  }

  if (!budgetState.budgetWarned && projectedCost >= budgetState.budgets.warn_at_usd) {
    budgetState.budgetWarned = true;
    log.warn("Projected session cost passed warn threshold", { projected_cost_usd: projectedCost, warn_threshold_usd: budgetState.budgets.warn_at_usd, agent_id: agentId, session_id: session.id });
    emitter.message(session.id, "orch-1", "Orchestrator", "user",
      `Budget warning: projected session cost $${projectedCost.toFixed(2)} has passed the $${budgetState.budgets.warn_at_usd} threshold.`);
  }

  if (projectedCost >= budgetState.budgets.max_per_session_usd) {
    throw new Error(`Budget exceeded: projected session cost $${projectedCost.toFixed(3)} >= limit $${budgetState.budgets.max_per_session_usd}`);
  }

  if (projectedTokens >= budgetState.budgets.max_total_tokens) {
    throw new Error(`Token budget exceeded: projected ${projectedTokens} >= limit ${budgetState.budgets.max_total_tokens}`);
  }
}
