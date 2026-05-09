import { loadModelRouting } from "./config";
import type { EventEmitter } from "./event-emitter";
import type { SessionState } from "./types";

export interface BudgetLimits {
  max_per_session_usd: number;
  warn_at_usd: number;
  max_per_agent_usd: number;
  max_total_tokens: number;
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
      console.log(`[budget] Limits: $${budgets.max_per_session_usd}/session, $${budgets.max_per_agent_usd}/agent, ${(budgets.max_total_tokens / 1e6).toFixed(0)}M tokens`);
    }
    return { budgets, budgetWarned: false };
  } catch {
    return { budgets: null, budgetWarned: false };
  }
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
  emitter: EventEmitter,
): void {
  if (!budgetState.budgets) return;

  if (agentCost > budgetState.budgets.max_per_agent_usd) {
    console.warn(`[budget] Agent ${agentId} exceeded per-agent limit: $${agentCost.toFixed(3)} > $${budgetState.budgets.max_per_agent_usd}`);
  }

  if (!budgetState.budgetWarned && session.totalCost >= budgetState.budgets.warn_at_usd) {
    budgetState.budgetWarned = true;
    console.warn(`[budget] WARNING: Session cost $${session.totalCost.toFixed(3)} passed warn threshold $${budgetState.budgets.warn_at_usd}`);
    emitter.message(session.id, "orch-1", "Orchestrator", "user",
      `Budget warning: session cost $${session.totalCost.toFixed(2)} has passed the $${budgetState.budgets.warn_at_usd} threshold.`);
  }

  if (session.totalCost >= budgetState.budgets.max_per_session_usd) {
    throw new Error(`Budget exceeded: session cost $${session.totalCost.toFixed(3)} >= limit $${budgetState.budgets.max_per_session_usd}`);
  }

  if (session.totalTokens >= budgetState.budgets.max_total_tokens) {
    throw new Error(`Token budget exceeded: ${session.totalTokens} >= limit ${budgetState.budgets.max_total_tokens}`);
  }
}
