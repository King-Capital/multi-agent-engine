import type { SessionEvent } from "./types";

export class EventEmitter {
  private dashboardUrl: string;
  private buffer: SessionEvent[] = [];
  private flushing = false;
  private pgAgentIds: Map<string, number> = new Map(); // engine agentId -> PG agent id

  constructor(dashboardUrl?: string) {
    this.dashboardUrl = dashboardUrl ?? "http://localhost:8400";
  }

  async emit(event: SessionEvent): Promise<void> {
    if (!event.timestamp) {
      event.timestamp = new Date().toISOString();
    }

    this.buffer.push(event);
    if (!this.flushing) {
      this.flushing = true;
      queueMicrotask(() => this.flush());
    }
  }

  private async flush(): Promise<void> {
    const events = this.buffer.splice(0);
    this.flushing = false;

    for (const event of events) {
      try {
        await fetch(`${this.dashboardUrl}/api/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        });
      } catch {
        console.error(`[event-emitter] Failed to send event: ${event.event_type}`);
      }
    }
  }

  sessionStart(sessionId: string, name: string, chain: string, task: string) {
    return this.emit({
      session_id: sessionId,
      agent_id: "orchestrator",
      event_type: "session_start",
      timestamp: new Date().toISOString(),
      data: {
        session_name: name,
        team_config: chain,
        task_prompt: task,
      },
    });
  }

  agentSpawn(
    sessionId: string,
    agentId: string,
    parentId: string,
    name: string,
    role: string,
    model: string,
    teamName: string,
    teamColor: string
  ) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      parent_id: parentId,
      event_type: "agent_spawn",
      timestamp: new Date().toISOString(),
      data: {
        agent_name: name,
        agent_role: role,
        model,
        team_name: teamName,
        team_color: teamColor,
      },
    });
  }

  message(sessionId: string, agentId: string, from: string, to: string, content: string) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "message",
      timestamp: new Date().toISOString(),
      data: { from, to, content },
    });
  }

  toolCall(
    sessionId: string,
    agentId: string,
    tool: string,
    filePath: string,
    status: string
  ) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "tool_call",
      timestamp: new Date().toISOString(),
      data: { tool, file_path: filePath, tool_status: status },
    });
  }

  costUpdate(
    sessionId: string,
    agentId: string,
    costUsd: number,
    tokensUsed: number,
    contextTokens: number
  ) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "cost_update",
      timestamp: new Date().toISOString(),
      cost_usd: costUsd,
      tokens_used: tokensUsed,
      context_tokens: contextTokens,
      data: {},
    });
  }

  tillDone(
    sessionId: string,
    title: string,
    items: Array<{ description: string; completed: boolean; active: boolean }>
  ) {
    const completed = items.filter((i) => i.completed).length;
    return this.emit({
      session_id: sessionId,
      agent_id: "orchestrator",
      event_type: "tilldone",
      timestamp: new Date().toISOString(),
      data: {
        tilldone: { title, items, completed, total: items.length },
      },
    });
  }

  domainBlock(
    sessionId: string,
    agentId: string,
    path: string,
    action: string,
    reason: string
  ) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "domain_block",
      timestamp: new Date().toISOString(),
      data: {
        blocked_path: path,
        blocked_action: action,
        block_reason: reason,
      },
    });
  }

  selfHeal(sessionId: string, agentId: string, failedWorker: string, action: string) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "self_heal",
      timestamp: new Date().toISOString(),
      data: { failed_worker: failedWorker, heal_action: action },
    });
  }

  sessionEnd(sessionId: string) {
    this.pgUpdateSession(sessionId, { status: "completed" });
    return this.emit({
      session_id: sessionId,
      agent_id: "orchestrator",
      event_type: "session_end",
      timestamp: new Date().toISOString(),
      data: {},
    });
  }

  // --- PG-backed persistence (best-effort, non-blocking) ---

  async pgCreateSession(opts: {
    id: string;
    name: string;
    platform?: string;
    userId?: number;
    team?: string;
    chain?: string;
    config?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await fetch(`${this.dashboardUrl}/api/pg/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: opts.id,
          name: opts.name,
          platform: opts.platform ?? "multi-agent-engine",
          user_id: opts.userId,
          team: opts.team,
          chain: opts.chain,
          config: opts.config,
        }),
      });
    } catch {
      console.error(`[event-emitter] Failed to create PG session: ${opts.id}`);
    }
  }

  async pgUpdateSession(sessionId: string, updates: { name?: string; status?: string }): Promise<void> {
    try {
      await fetch(`${this.dashboardUrl}/api/pg/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
    } catch {
      console.error(`[event-emitter] Failed to update PG session: ${sessionId}`);
    }
  }

  async pgCreateAgent(opts: {
    sessionId: string;
    agentId: string;
    role: string;
    persona?: string;
    adapter?: string;
    prompt?: string;
    config?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const res = await fetch(`${this.dashboardUrl}/api/pg/sessions/${opts.sessionId}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: opts.sessionId,
          agent_id: opts.agentId,
          role: opts.role,
          persona: opts.persona,
          adapter: opts.adapter,
          status: "running",
          prompt: opts.prompt,
          config: opts.config,
        }),
      });
      if (res.ok) {
        const agent = (await res.json()) as { id?: number };
        if (agent?.id) {
          this.pgAgentIds.set(opts.agentId, agent.id);
        }
      }
    } catch {
      console.error(`[event-emitter] Failed to create PG agent: ${opts.agentId}`);
    }
  }

  async pgUpdateAgent(agentId: string, updates: {
    status?: string;
    config?: Record<string, unknown>;
    result?: Record<string, unknown>;
    cost_usd?: number;
  }): Promise<void> {
    const pgId = this.pgAgentIds.get(agentId);
    if (!pgId) return;
    try {
      await fetch(`${this.dashboardUrl}/api/pg/agents/${pgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
    } catch {
      console.error(`[event-emitter] Failed to update PG agent: ${agentId}`);
    }
  }
}
