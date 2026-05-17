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
      const teamName = String(data.team_name ?? "");
      const inferredParent = teamName.toLowerCase() === "synthesis" && agentId !== "orch-1" ? "orch-1" : undefined;
      agentMap.set(agentId, {
        id: agentId,
        name: String(data.agent_name ?? agentId),
        role: String(data.agent_role ?? "worker"),
        model: String(data.model ?? ""),
        team_name: teamName,
        team_color: String(data.team_color ?? "#22d3ee"),
        parent_id:
          (payload.parent_id as string | undefined) ??
          (data.parent_id as string | undefined) ??
          inferredParent,
        status: "running",
        persona_path: data.persona_path ? String(data.persona_path) : undefined,
        cost_usd: 0,
        tokens_used: 0,
        context_tokens: 0,
        context_max: 0,
        started_at: (payload.timestamp as string) ?? evt.created_at ?? new Date().toISOString(),
        elapsed_ms: 0,
        last_activity_at: (payload.timestamp as string) ?? evt.created_at ?? new Date().toISOString(),
        current_activity: "spawned",
      });
    } else if (eventType === "agent_done") {
      const existing = agentMap.get(agentId);
      if (existing) {
        existing.status = String(data.status ?? "done");
        const cost = typeof payload.cost_usd === "number" ? payload.cost_usd : data.cost_usd;
        const tokens = typeof payload.tokens_used === "number" ? payload.tokens_used : data.tokens_used;
        if (typeof cost === "number") existing.cost_usd = cost;
        if (typeof tokens === "number") existing.tokens_used = tokens;
        existing.last_activity_at = (payload.timestamp as string) ?? evt.created_at ?? existing.last_activity_at;
        if (typeof data.output_artifact === "string") existing.output_artifact = data.output_artifact;
        if (typeof data.task_report === "string") existing.task_report = data.task_report;
        existing.current_activity = "done";
      }
    } else if (eventType === "cost_update") {
      const existing = agentMap.get(agentId);
      if (existing) {
        if (typeof payload.cost_usd === "number") existing.cost_usd = payload.cost_usd;
        if (typeof payload.tokens_used === "number") existing.tokens_used = payload.tokens_used;
        if (typeof payload.context_tokens === "number") existing.context_tokens = payload.context_tokens;
        existing.last_activity_at = (payload.timestamp as string) ?? evt.created_at ?? existing.last_activity_at;
        existing.current_activity = "cost update";
      }
    } else if (eventType === "tool_call" || eventType === "tool_result") {
      const existing = agentMap.get(agentId);
      if (existing) {
        existing.last_activity_at = (payload.timestamp as string) ?? evt.created_at ?? existing.last_activity_at;
        const tool = data.tool ? String(data.tool) : eventType.replace("_", " ");
        existing.current_activity = tool;
      }
    } else if (eventType === "message" || eventType === "agent_message") {
      const existing = agentMap.get(agentId);
      if (existing) {
        existing.last_activity_at = (payload.timestamp as string) ?? evt.created_at ?? existing.last_activity_at;
        existing.current_activity = "message";
      }
    } else if (eventType === "error") {
      const existing = agentMap.get(agentId);
      if (existing) {
        existing.status = "error";
        existing.last_activity_at = (payload.timestamp as string) ?? evt.created_at ?? existing.last_activity_at;
        existing.current_activity = "error";
      }
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
      // Event spawn data has better display identity than sparse PG rows.
      // PG rows can persist only role/status/cost and leave model/team_color as "unknown",
      // which makes all leads render with the generic blue lead fallback.
      merged.set(a.id, {
        ...existing,
        name: a.name && a.name !== a.id ? a.name : existing.name,
        model: a.model && a.model !== "unknown" ? a.model : existing.model,
        team_name: a.team_name || existing.team_name,
        team_color: a.team_color || existing.team_color,
        parent_id: a.parent_id ?? existing.parent_id,
        persona_path: a.persona_path ?? existing.persona_path,
        last_activity_at: a.last_activity_at ?? existing.last_activity_at,
        current_activity: a.current_activity ?? existing.current_activity,
        output_artifact: a.output_artifact ?? existing.output_artifact,
        task_report: a.task_report ?? existing.task_report,
        cost_usd: a.cost_usd > 0 ? a.cost_usd : existing.cost_usd,
        tokens_used: a.tokens_used > 0 ? a.tokens_used : existing.tokens_used,
        context_tokens: a.context_tokens > 0 ? a.context_tokens : existing.context_tokens,
        status: a.status || existing.status,
      });
    } else {
      merged.set(a.id, a);
    }
  }

  return Array.from(merged.values());
}
