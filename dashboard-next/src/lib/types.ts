// ─── Shared primitives ────────────────────────────────────────────────────────

export type SessionStatus =
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  | "error"
  | "waiting"
  | string;

export type AgentStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "blocked"
  | string;

export type AgentRole = "orchestrator" | "lead" | "worker" | string;

// ─── DB shapes (from Go API) ──────────────────────────────────────────────────

export interface DBUser {
  id: number;
  username: string;
  display_name: string;
  uid: number;
  gid: number;
  role: string;
  created_at: string;
}

export interface DBSession {
  id: string;
  user_id?: number | null;
  name: string;
  platform: string;
  team?: string | null;
  chain?: string | null;
  status: SessionStatus;
  config?: unknown;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export interface DBAgent {
  id: number;
  session_id: string;
  agent_id: string;
  role: AgentRole;
  persona?: string | null;
  adapter?: string | null;
  status: AgentStatus;
  prompt?: string | null;
  config?: unknown;
  result?: unknown;
  cost_usd: number;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBEvent {
  id: number;
  session_id: string;
  agent_id?: string | null;
  event_type: string;
  payload?: LiveEvent | Record<string, unknown> | null;
  created_at: string;
}

// ─── Live event model (from in-memory store / SSE) ────────────────────────────

export interface EventData {
  // session_start
  session_name?: string;
  team_config?: string;
  task_prompt?: string;

  // agent_spawn / agent_done
  agent_name?: string;
  agent_role?: AgentRole;
  model?: string;
  team_name?: string;
  team_color?: string;
  persona_path?: string;
  grade?: string;
  status?: AgentStatus;

  // message
  from?: string;
  to?: string;
  content?: string;

  // tool_call
  tool?: string;
  tool_args?: string;
  tool_result?: string;
  tool_status?: string;
  file_path?: string;

  // tilldone
  tilldone?: TillDoneState;

  // domain_block
  blocked_path?: string;
  blocked_action?: string;
  block_reason?: string;

  // self_heal
  failed_worker?: string;
  heal_action?: string;

  // error
  error_msg?: string;

  // session_state
  phase?: string;
  active_leads?: string[];
  progress?: number;
  current_step?: number;
  total_steps?: number;
  assessment?: string;
  session_status?: string;
  budget_percent?: number;
  actions?: string[];

  // stall_detected / nudge_sent
  idle_seconds?: number;
  nudge_type?: string;
  nudge_count?: number;
  nudge_message?: string;

  // severity_alert
  severity?: string;
  excerpt?: string;

  // auto_pause / budget_warning
  reason?: string;
  current_cost?: number;
  projected_cost?: number;
  remaining_budget?: number;
  percent_used?: number;
  burn_rate?: number;
  will_exceed?: boolean;
  budget_action?: string;
}

export interface TillDoneItem {
  description: string;
  completed: boolean;
  active: boolean;
}

export interface TillDoneState {
  title: string;
  items: TillDoneItem[];
  completed: number;
  total: number;
}

/** Live event emitted over SSE or stored in-memory */
export interface LiveEvent {
  session_id: string;
  agent_id: string;
  parent_id?: string;
  event_type: string;
  timestamp?: string;
  tokens_used?: number;
  cost_usd?: number;
  context_tokens?: number;
  data?: EventData & Record<string, unknown>;
}

// ─── SSE event union (typed by event_type) ────────────────────────────────────

export type SSEEvent =
  | (LiveEvent & { event_type: "session_start" })
  | (LiveEvent & { event_type: "session_end" })
  | (LiveEvent & { event_type: "agent_spawn" })
  | (LiveEvent & { event_type: "agent_done" })
  | (LiveEvent & { event_type: "message" })
  | (LiveEvent & { event_type: "tool_call" })
  | (LiveEvent & { event_type: "tilldone" })
  | (LiveEvent & { event_type: "cost_update" })
  | (LiveEvent & { event_type: "domain_block" })
  | (LiveEvent & { event_type: "self_heal" })
  | (LiveEvent & { event_type: "error" })
  | (LiveEvent & { event_type: "pause" })
  | (LiveEvent & { event_type: "resume" })
  | (LiveEvent & { event_type: "waiting" })
  | (LiveEvent & { event_type: "session_state" })
  | (LiveEvent & { event_type: "stall_detected" })
  | (LiveEvent & { event_type: "nudge_sent" })
  | (LiveEvent & { event_type: "budget_warning" })
  | (LiveEvent & { event_type: "severity_alert" })
  | (LiveEvent & { event_type: "auto_pause" })
  | LiveEvent; // fallback for unknown types

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface DayCost {
  day: string;
  cost: number;
}

export interface ChainCost {
  chain: string;
  cost: number;
  sessions: number;
}

export interface StatsResponse {
  total_sessions: number;
  total_agents: number;
  total_cost: number;
  total_events: number;
  cost_per_day: DayCost[];
  top_chains: ChainCost[];
}

// ─── History ─────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  name: string;
  chain?: string | null;
  status: SessionStatus;
  created_at: string;
  completed_at?: string | null;
  total_cost: number;
  agent_count: number;
  duration_secs: number;
}

// ─── Health ──────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  version?: string;
  db?: string;
  uptime_seconds?: number;
}

// ─── Diff ────────────────────────────────────────────────────────────────────

/** Simple diff response from /api/pg/sessions/:id/diff */
export interface DiffResponse {
  files: string[];
  count: number;
}

/** Enriched diff file with change stats (when API supports it) */
export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
  old_path?: string;
}

// ─── Live Agent (from /api/pg/sessions/:id/agents) ───────────────────────────

/** Full agent record from the Go API — mirrors models.Agent */
export interface LiveAgent {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  team_name: string;
  team_color: string;
  parent_id?: string;
  status: AgentStatus;
  persona_path?: string;
  cost_usd: number;
  tokens_used: number;
  context_tokens: number;
  context_max: number;
  started_at: string;
  elapsed_ms: number;
}

// ─── Prometheus metrics ───────────────────────────────────────────────────────

export interface MetricEntry {
  name: string;
  labels: Record<string, string>;
  value: number;
}
