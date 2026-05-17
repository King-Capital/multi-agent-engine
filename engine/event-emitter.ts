import type { SessionEvent, SessionStateEvent } from "./types";
import type { BudgetProjection } from "./budget";
import { createLogger } from "./logger";
import { redactSecrets } from "./security";

const log = createLogger("event-emitter");
const RETRY_DELAYS = [100, 500, 2000];

function isSecretKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|authorization)/i.test(key);
}

function redactValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") return isSecretKey(key) ? "[REDACTED_SECRET]" : redactSecrets(value);
  if (Array.isArray(value)) return value.map((nested) => redactValue(nested, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([nestedKey, nested]) => [nestedKey, redactValue(nested, nestedKey)]),
    );
  }
  return value;
}

function redactRecord<T extends Record<string, unknown>>(record: T): T {
  return redactValue(record) as T;
}

export class EventEmitter {
  private dashboardUrl: string;
  private apiToken: string | undefined;
  private disabled: boolean;
  private buffer: SessionEvent[] = [];
  private flushing = false;
  private seq = 0;
  private pgAgentIds: Map<string, number> = new Map();
  private droppedEvents = 0;
  private dashboardDown = false;
  private dashboardDownAt = 0;
  private static readonly DASHBOARD_RETRY_MS = 30_000;
  private static readonly MAX_BUFFER_SIZE = 1000;

  constructor(dashboardUrl?: string, apiToken?: string) {
    this.dashboardUrl = dashboardUrl ?? process.env.MAE_DASHBOARD_URL ?? "http://localhost:8400";
    this.disabled = this.dashboardUrl.trim() === "" || this.dashboardUrl === "off" || process.env.MAE_DISABLE_DASHBOARD === "1";
    log.info(this.disabled ? "Dashboard event streaming disabled" : "Dashboard URL configured", { dashboardUrl: this.dashboardUrl || "(disabled)" });
    this.apiToken = apiToken ?? process.env.MAE_API_TOKEN;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }
    return headers;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response | null> {
    if (this.dashboardDown) {
      if (Date.now() - this.dashboardDownAt < EventEmitter.DASHBOARD_RETRY_MS) return null;
      this.dashboardDown = false;
    }
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const res = await fetch(url, init);
        if (res.ok || (res.status < 500 && res.status !== 429)) return res;
        if (attempt < RETRY_DELAYS.length) {
          await Bun.sleep(RETRY_DELAYS[attempt]!);
        }
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code ?? "";
        if (code === "ConnectionRefused") {
          this.dashboardDown = true;
          this.dashboardDownAt = Date.now();
          return null;
        }
        if (attempt < RETRY_DELAYS.length) {
          await Bun.sleep(RETRY_DELAYS[attempt]!);
        }
      }
    }
    return null;
  }

  async emit(event: SessionEvent): Promise<void> {
    if (this.disabled) return;

    event.data = redactRecord(event.data);

    if (!event.timestamp) {
      event.timestamp = new Date().toISOString();
    }

    // Assign monotonic sequence number for ordering
    (event as SessionEvent & { seq: number }).seq = ++this.seq;

    if (this.buffer.length >= EventEmitter.MAX_BUFFER_SIZE) {
      this.buffer.shift();
      this.droppedEvents++;
    }
    this.buffer.push(event);
    if (!this.flushing) {
      this.flushing = true;
      queueMicrotask(() => this.flush());
    }
  }

  private async flush(): Promise<void> {
    // Serialized flush: keep draining buffer until empty
    while (this.buffer.length > 0) {
      const events = this.buffer.splice(0);

      for (const event of events) {
        const res = await this.fetchWithRetry(`${this.dashboardUrl}/api/events`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify(event),
        });
        if (!res) {
          this.droppedEvents++;
          log.error("Dropped event after retries", { event_type: event.event_type });
        }
      }
    }
    this.flushing = false;
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
        task_prompt: redactSecrets(task),
      },
    });
  }

  async agentSpawn(
    sessionId: string,
    agentId: string,
    parentId: string,
    name: string,
    role: string,
    model: string,
    teamName: string,
    teamColor: string
  ) {
    await this.pgCreateAgent({
      sessionId,
      agentId,
      role,
      persona: name,
      config: { model, team_name: teamName, team_color: teamColor, parent_id: parentId },
    });
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

  async agentDone(sessionId: string, agentId: string, grade?: string, costUsd?: number, artifacts: { outputArtifact?: string; taskReport?: string } = {}) {
    await this.pgUpdateAgent(agentId, {
      status: grade === "FAILED" ? "failed" : "completed",
      cost_usd: costUsd ?? 0,
    });
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "agent_done",
      timestamp: new Date().toISOString(),
      data: {
        grade: grade ?? "unknown",
        cost_usd: costUsd ?? 0,
        ...(artifacts.outputArtifact ? { output_artifact: artifacts.outputArtifact } : {}),
        ...(artifacts.taskReport ? { task_report: artifacts.taskReport } : {}),
      },
    });
  }

  message(
    sessionId: string,
    agentId: string,
    from: string,
    to: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "message",
      timestamp: new Date().toISOString(),
      data: { ...redactRecord(metadata), from, to, content: redactSecrets(content) },
    });
  }

  toolCall(
    sessionId: string,
    agentId: string,
    tool: string,
    filePath: string,
    status: string,
    toolArgs?: string,
    toolResult?: string
  ) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "tool_call",
      timestamp: new Date().toISOString(),
      data: {
        tool,
        file_path: filePath,
        tool_status: status,
        tool_args: redactSecrets(toolArgs ?? ""),
        tool_result: redactSecrets(toolResult ?? ""),
      },
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

  stallDetected(sessionId: string, agentId: string, agentName: string, idleSeconds: number) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "stall_detected",
      timestamp: new Date().toISOString(),
      data: { agent_name: agentName, idle_seconds: idleSeconds },
    });
  }

  nudgeSent(sessionId: string, agentId: string, agentName: string, nudgeType: string, nudgeCount: number, message: string) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "nudge_sent",
      timestamp: new Date().toISOString(),
      data: { agent_name: agentName, nudge_type: nudgeType, nudge_count: nudgeCount, nudge_message: message },
    });
  }

  budgetWarning(sessionId: string, projection: BudgetProjection) {
    return this.emit({
      session_id: sessionId,
      agent_id: "orchestrator",
      event_type: "budget_warning",
      timestamp: new Date().toISOString(),
      data: {
        current_cost: projection.currentCost,
        projected_cost: projection.projectedCost,
        remaining_budget: projection.remainingBudget,
        percent_used: projection.percentUsed,
        burn_rate: projection.burnRatePerMinute,
        will_exceed: projection.willExceed,
        budget_action: projection.action,
      },
    });
  }

  severityAlert(sessionId: string, agentId: string, severity: string, excerpt: string) {
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      event_type: "severity_alert",
      timestamp: new Date().toISOString(),
      data: { severity, excerpt },
    });
  }

  sessionState(sessionId: string, state: SessionStateEvent) {
    return this.emit({
      session_id: sessionId,
      agent_id: "orchestrator",
      event_type: "session_state",
      timestamp: new Date().toISOString(),
      data: state as unknown as Record<string, unknown>,
    });
  }

  autoPause(sessionId: string, reason: string) {
    return this.emit({
      session_id: sessionId,
      agent_id: "orchestrator",
      event_type: "auto_pause",
      timestamp: new Date().toISOString(),
      data: { reason },
    });
  }

  async sessionEnd(sessionId: string, status: string = "completed") {
    if (this.droppedEvents > 0) {
      log.warn("Session ended with dropped events", { dropped_events: this.droppedEvents });
    }
    await this.pgUpdateSession(sessionId, { status });
    return this.emit({
      session_id: sessionId,
      agent_id: "orchestrator",
      event_type: "session_end",
      timestamp: new Date().toISOString(),
      data: { status },
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
    if (this.disabled) return;

    const res = await this.fetchWithRetry(`${this.dashboardUrl}/api/pg/sessions`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        id: opts.id,
        name: redactSecrets(opts.name),
        platform: opts.platform ? redactSecrets(opts.platform) : "multi-agent-engine",
        user_id: opts.userId,
        team: opts.team ? redactSecrets(opts.team) : undefined,
        chain: opts.chain ? redactSecrets(opts.chain) : undefined,
        config: opts.config ? redactRecord(opts.config) : undefined,
      }),
    });
    if (!res) log.error("Failed to create PG session after retries", { session_id: opts.id });
  }

  async pgUpdateSession(sessionId: string, updates: { name?: string; status?: string }): Promise<void> {
    if (this.disabled) return;

    const res = await this.fetchWithRetry(`${this.dashboardUrl}/api/pg/sessions/${sessionId}`, {
      method: "PATCH",
      headers: this.authHeaders(),
      body: JSON.stringify(redactRecord(updates as Record<string, unknown>)),
    });
    if (!res) log.error("Failed to update PG session after retries", { session_id: sessionId });
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
    if (this.disabled) return;

    const res = await this.fetchWithRetry(`${this.dashboardUrl}/api/pg/sessions/${opts.sessionId}/agents`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        session_id: opts.sessionId,
        agent_id: opts.agentId,
        role: opts.role,
        persona: opts.persona,
        adapter: opts.adapter,
        status: "running",
        prompt: opts.prompt ? redactSecrets(opts.prompt) : undefined,
        config: opts.config ? redactRecord(opts.config) : undefined,
      }),
    });
    if (res?.ok) {
      const agent = (await res.json()) as { id?: number };
      if (agent?.id) {
        this.pgAgentIds.set(opts.agentId, agent.id);
      }
    } else {
      log.error("Failed to create PG agent after retries", { agent_id: opts.agentId });
    }
  }

  async pgUpdateAgent(agentId: string, updates: {
    status?: string;
    config?: Record<string, unknown>;
    result?: Record<string, unknown>;
    cost_usd?: number;
  }): Promise<void> {
    if (this.disabled) return;

    const pgId = this.pgAgentIds.get(agentId);
    if (!pgId) return;
    const res = await this.fetchWithRetry(`${this.dashboardUrl}/api/pg/agents/${pgId}`, {
      method: "PATCH",
      headers: this.authHeaders(),
      body: JSON.stringify(redactRecord(updates as Record<string, unknown>)),
    });
    if (!res) log.error("Failed to update PG agent after retries", { agent_id: agentId });
  }

  async trace(sessionId: string, agentId: string, direction: "input" | "output", content: string, metadata?: Record<string, unknown>): Promise<void> {
    if (this.disabled) return;

    const res = await this.fetchWithRetry(`${this.dashboardUrl}/api/traces`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        session_id: sessionId,
        agent_id: agentId,
        direction,
        content: redactSecrets(content),
        metadata: metadata ? redactRecord(metadata) : undefined,
      }),
    });
    if (!res) log.error("Failed to record trace", { agent_id: agentId, direction });
  }
}
