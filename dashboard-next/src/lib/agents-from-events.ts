/**
 * Reconstruct LiveAgent[] from DBEvent stream.
 *
 * Shared utility used by AgentGraph, AgentTreePanel, and CostTab.
 * PG agent records are often incomplete (only orchestrator persisted) while
 * events contain the full agent_spawn / agent_done / cost_update history.
 */

import type { DBEvent, LiveAgent } from "./types";

export function buildAgentsFromEvents(dbEvents: DBEvent[]): LiveAgent[] {
  const agentMap = new Map<string, LiveAgent>();

  for (const evt of dbEvents) {
    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    const eventType = (payload.event_type as string) ?? evt.event_type;
    const agentId = (payload.agent_id as string) ?? evt.agent_id;
    const data = ((payload.data as Record<string, unknown>) ?? payload) as Record<string, unknown>;

    if (!agentId) continue;

    if (eventType === "agent_spawn") {
      agentMap.set(agentId, {
        id: agentId,
        name: String(data.agent_name ?? agentId),
        role: String(data.agent_role ?? "worker"),
        model: String(data.model ?? ""),
        team_name: String(data.team_name ?? ""),
        team_color: String(data.team_color ?? "#22d3ee"),
        parent_id:
          (payload.parent_id as string | undefined) ??
          (data.parent_id as string | undefined),
        status: "running",
        persona_path: data.persona_path ? String(data.persona_path) : undefined,
        cost_usd: 0,
        tokens_used: 0,
        context_tokens: 0,
        context_max: 0,
        started_at: (payload.timestamp as string) ?? evt.created_at ?? new Date().toISOString(),
        elapsed_ms: 0,
      });
    } else if (eventType === "agent_done") {
      const existing = agentMap.get(agentId);
      if (existing) {
        existing.status = String(data.status ?? "done");
        if (typeof payload.cost_usd === "number") existing.cost_usd = payload.cost_usd;
        if (typeof payload.tokens_used === "number") existing.tokens_used = payload.tokens_used;
      }
    } else if (eventType === "cost_update") {
      const existing = agentMap.get(agentId);
      if (existing) {
        if (typeof payload.cost_usd === "number") existing.cost_usd = payload.cost_usd;
        if (typeof payload.tokens_used === "number") existing.tokens_used = payload.tokens_used;
        if (typeof payload.context_tokens === "number") existing.context_tokens = payload.context_tokens;
      }
    } else if (eventType === "error") {
      const existing = agentMap.get(agentId);
      if (existing) existing.status = "error";
    }
  }

  return Array.from(agentMap.values());
}

/**
 * Merge PG agents with event-reconstructed agents.
 * Event data wins for cost/tokens since PG records are often stale.
 */
export function mergeAgents(pgAgents: LiveAgent[], eventAgents: LiveAgent[]): LiveAgent[] {
  const merged = new Map<string, LiveAgent>();

  // Start with PG agents
  for (const a of pgAgents) merged.set(a.id, a);

  // Overlay event agents (they have better cost/status data)
  for (const a of eventAgents) {
    const existing = merged.get(a.id);
    if (existing) {
      // Keep PG fields but override cost/tokens/status from events
      merged.set(a.id, {
        ...existing,
        cost_usd: a.cost_usd > 0 ? a.cost_usd : existing.cost_usd,
        tokens_used: a.tokens_used > 0 ? a.tokens_used : existing.tokens_used,
        context_tokens: a.context_tokens > 0 ? a.context_tokens : existing.context_tokens,
        status: a.status !== "running" ? a.status : existing.status,
      });
    } else {
      merged.set(a.id, a);
    }
  }

  return Array.from(merged.values());
}
