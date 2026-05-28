import type { ParticipantCapabilities, ParticipantKind, ParticipantStatus, SessionEvent, SessionStateEvent, SteerEventData, SteerSource, SteerIntent } from "./types";
import type { BudgetProjection } from "./budget";
import type { SpawnDecision, SpawnDecisionValidation } from "./spawn-decision";
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

function participantKindForRole(role: string): ParticipantKind {
  if (role === "orchestrator" || role === "lead" || role === "worker" || role === "sr" || role === "synthesis") return role;
  return "system";
}

/** Default authority level for web/CLI steer operators. */
export const STEER_AUTHORITY = 90;

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

  private participantEvent(
    sessionId: string,
    agentId: string,
    eventType: "participant_start" | "participant_activity" | "participant_heartbeat" | "participant_stale" | "participant_end",
    data: {
      name?: string;
      kind?: ParticipantKind;
      status?: ParticipantStatus;
      role?: string;
      teamName?: string;
      model?: string;
      currentTask?: string;
      currentTool?: string;
      lastEvent?: string;
      costUsd?: number;
      tokensUsed?: number;
      capabilities?: ParticipantCapabilities;
      reason?: string;
    } = {},
    parentId?: string,
  ) {
    const timestamp = new Date().toISOString();
    const payload: Record<string, unknown> = {
      participant_id: agentId,
      status: data.status ?? "active",
      last_heartbeat_ts: timestamp,
      ...(data.name ? { name: data.name } : {}),
      ...(data.kind ? { kind: data.kind } : {}),
      ...(data.role ? { role: data.role } : {}),
      ...(data.teamName ? { team: data.teamName } : {}),
      ...(data.model ? { model: data.model } : {}),
      ...(data.currentTask ? { current_task: redactSecrets(data.currentTask) } : {}),
      ...(data.currentTool ? { current_tool: data.currentTool } : {}),
      ...(data.lastEvent ? { last_event: data.lastEvent } : {}),
      ...(data.costUsd !== undefined ? { cost_usd: data.costUsd } : {}),
      ...(data.tokensUsed !== undefined ? { tokens_used: data.tokensUsed } : {}),
      ...(data.capabilities ? { capabilities: redactRecord(data.capabilities as Record<string, unknown>) } : {}),
      ...(data.reason ? { reason: redactSecrets(data.reason) } : {}),
    };
    log.info("Participant event", {
      trace_type: eventType.replace(/_/g, "."),
      session_id: sessionId,
      agent_id: agentId,
      parent_id: parentId,
      ...payload,
    });
    return this.emit({
      session_id: sessionId,
      agent_id: agentId,
      parent_id: parentId,
      event_type: eventType,
      timestamp,
      data: payload,
    });
  }

  participantStart(sessionId: string, agentId: string, opts: {
    parentId?: string;
    name: string;
    kind: ParticipantKind;
    role?: string;
    teamName?: string;
    model?: string;
    currentTask?: string;
    capabilities?: ParticipantCapabilities;
  }) {
    return this.participantEvent(sessionId, agentId, "participant_start", {
      name: opts.name,
      kind: opts.kind,
      role: opts.role,
      teamName: opts.teamName,
      model: opts.model,
      currentTask: opts.currentTask,
      capabilities: opts.capabilities,
      status: "active",
      lastEvent: "participant_start",
    }, opts.parentId);
  }

  participantActivity(sessionId: string, agentId: string, opts: { currentTask?: string; currentTool?: string; lastEvent?: string } = {}) {
    return this.participantEvent(sessionId, agentId, "participant_activity", {
      status: "active",
      currentTask: opts.currentTask,
      currentTool: opts.currentTool,
      lastEvent: opts.lastEvent ?? "activity",
    });
  }

  participantHeartbeat(
    sessionId: string,
    agentId: string,
    opts: {
      status?: ParticipantStatus;
      currentTask?: string;
      currentTool?: string;
      costUsd?: number;
      tokensUsed?: number;
      lastEvent?: string;
    } = {}
  ) {
    return this.participantEvent(sessionId, agentId, "participant_heartbeat", {
      status: opts.status ?? "active",
      currentTask: opts.currentTask,
      currentTool: opts.currentTool,
      costUsd: opts.costUsd,
      tokensUsed: opts.tokensUsed,
      lastEvent: opts.lastEvent ?? "heartbeat",
    });
  }

  participantStale(sessionId: string, agentId: string, reason: string) {
    return this.participantEvent(sessionId, agentId, "participant_stale", {
      status: "stale",
      reason,
      lastEvent: "stale",
    });
  }

  participantEnd(sessionId: string, agentId: string, status: "completed" | "failed" | "blocked" = "completed", opts: { lastEvent?: string; costUsd?: number; tokensUsed?: number; reason?: string } = {}) {
    return this.participantEvent(sessionId, agentId, "participant_end", {
      status,
      costUsd: opts.costUsd,
      tokensUsed: opts.tokensUsed,
      reason: opts.reason,
      lastEvent: opts.lastEvent ?? "participant_end",
    });
  }

  // --- Phase 5: Steer participant lifecycle and steer events ---

  private steerParticipantCounter = 0;

  /**
   * Generate a stable steer participant ID.
   * Web steer and CLI steer are transient participants — each steer action
   * gets a start/end lifecycle bracket. The counter ensures unique IDs within
   * a session.
   */
  private nextSteerParticipantId(source: SteerSource): string {
    this.steerParticipantCounter++;
    const kind = source === "cli" ? "cli-steer" : "web-steer";
    return `${kind}-${this.steerParticipantCounter}`;
  }

  /**
   * Emit a steer event and bracket it with participant start/end lifecycle.
   * Steer participants are transient — they represent a single human or API
   * interaction, not a long-running agent.
   */
  async steerAction(sessionId: string, data: SteerEventData): Promise<string> {
    const participantId = this.nextSteerParticipantId(data.source);
    const kind: ParticipantKind = data.source === "cli" ? "cli-steer" : "web-steer";
    const name = data.source === "cli" ? "CLI Operator" : data.source === "web" ? "Dashboard Operator" : "API Operator";
    const timestamp = new Date().toISOString();

    // 1. participant_start
    await this.participantStart(sessionId, participantId, {
      name,
      kind,
      role: "steer",
      currentTask: `${data.intent}: ${data.content.slice(0, 80)}`,
      capabilities: {
        canSteer: true,
        canReceiveSteer: false,
        canSpawnWorkers: false,
        canReviewWorkers: false,
        canWriteFiles: false,
        canDelegate: false,
        authority: data.authority,
      },
    });

    try {
      // 2. steer_action event with full structured data
      const payload: Record<string, unknown> = {
        sender: data.sender,
        source: data.source,
        authority: data.authority,
        intent: data.intent,
        target: data.target,
        content: redactSecrets(data.content),
        certification_impact: data.certification_impact,
        ...(data.reason ? { reason: redactSecrets(data.reason) } : {}),
        ...(data.message_id ? { message_id: data.message_id } : {}),
      };

      log.info("Steer action", {
        trace_type: "steer.action",
        session_id: sessionId,
        participant_id: participantId,
        ...payload,
      });

      await this.emit({
        session_id: sessionId,
        agent_id: participantId,
        event_type: "steer_action",
        timestamp,
        data: payload,
      });
    } finally {
      // 3. participant_end (transient — always close the bracket)
      await this.participantEnd(sessionId, participantId, "completed", {
        lastEvent: "steer_action",
      });
    }

    return participantId;
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

  async sessionStart(sessionId: string, name: string, chain: string, task: string) {
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
    teamColor: string,
    participantKind?: ParticipantKind,
    capabilities?: ParticipantCapabilities,
  ) {
    await this.pgCreateAgent({
      sessionId,
      agentId,
      role,
      persona: name,
      config: { model, team_name: teamName, team_color: teamColor, parent_id: parentId },
    });
    const kind = participantKind ?? participantKindForRole(role);
    await this.participantStart(sessionId, agentId, {
      parentId,
      name,
      kind,
      role,
      teamName,
      model,
      currentTask: `agent:${kind}`,
      capabilities: capabilities ?? { model, canReceiveSteer: true },
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
    const participantStatus = grade === "FAILED" ? "failed" as const
      : grade === "FEEDBACK" ? "blocked" as const
      : "completed" as const;
    await this.pgUpdateAgent(agentId, {
      status: participantStatus === "blocked" ? "failed" : participantStatus,
      cost_usd: costUsd ?? 0,
    });
    await this.participantEnd(sessionId, agentId, participantStatus, {
      lastEvent: "agent_done",
      costUsd: costUsd ?? 0,
      reason: grade ?? "unknown",
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

  async toolCall(
    sessionId: string,
    agentId: string,
    tool: string,
    filePath: string,
    status: string,
    toolArgs?: string,
    toolResult?: string
  ) {
    await this.participantActivity(sessionId, agentId, {
      currentTool: tool,
      currentTask: filePath || status,
      lastEvent: "tool_call",
    });
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

  async costUpdate(
    sessionId: string,
    agentId: string,
    costUsd: number,
    tokensUsed: number,
    contextTokens: number
  ) {
    await this.participantHeartbeat(sessionId, agentId, {
      costUsd,
      tokensUsed,
      lastEvent: "cost_update",
    });
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

  spawnDecision(
    sessionId: string,
    workerId: string,
    parentId: string,
    decision: SpawnDecision,
    validation?: SpawnDecisionValidation,
  ) {
    const data: Record<string, unknown> = {
      need_worker: decision.need_worker,
      worker_name: decision.worker_name,
      spawn_type: decision.spawn_type,
      reason: decision.reason,
      why_lead_cannot_do_it: decision.why_lead_cannot_do_it,
      constraints: decision.constraints,
      bus_policy: decision.bus_policy,
      expected_output_schema: decision.expected_output_schema,
      timeout_seconds: decision.timeout_seconds,
      ...(validation ? { validation } : {}),
    };
    const redactedData = redactRecord(data);
    log.info("Spawn decision", {
      trace_type: "spawn.decision",
      session_id: sessionId,
      agent_id: workerId,
      parent_id: parentId,
      ...redactedData,
    });
    return this.emit({
      session_id: sessionId,
      agent_id: workerId,
      parent_id: parentId,
      event_type: "spawn_decision",
      timestamp: new Date().toISOString(),
      data: redactedData,
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
