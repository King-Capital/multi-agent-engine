export type AgentRole = "orchestrator" | "lead" | "sr" | "worker" | "scout";

export type ParticipantKind = "orchestrator" | "lead" | "worker" | "sr" | "synthesis" | "validator" | "web-steer" | "cli-steer" | "system";
export type ParticipantStatus = "starting" | "active" | "idle" | "stale" | "completed" | "failed" | "blocked";

export interface ParticipantCapabilities {
  canReceiveSteer?: boolean;
  canSteer?: boolean;
  canSpawnWorkers?: boolean;
  canReviewWorkers?: boolean;
  canWriteFiles?: boolean;
  canDelegate?: boolean;
  authority?: number;
  toolCount?: number;
  readScopeCount?: number;
  writeScopeCount?: number;
  model?: string;
}

export interface ParticipantState {
  participant_id: string;
  kind: ParticipantKind;
  status: ParticipantStatus;
  name: string;
  role?: AgentRole | string;
  team?: string;
  model?: string;
  current_task?: string;
  current_tool?: string;
  last_event?: string;
  last_heartbeat_ts?: string;
  started_at?: string;
  ended_at?: string;
  cost_usd?: number;
  tokens_used?: number;
  capabilities?: ParticipantCapabilities;
}

export interface ParticipantEventData extends ParticipantState {
  reason?: string;
}

// --- Team Template & Expertise Types (#184) ---

export interface TeamTemplate {
  name: string;
  description: string;
  color: string;
  lead: { name: string; role: string; model: string; specialization?: string };
  members: { name: string; role: string; model: string; specialization: string }[];
  chain?: { description: string; steps: ChainStep[] };
}

export interface ExpertiseSection {
  domain_rules: string[];
  terminology: Record<string, string>;
  patterns: { name: string; description: string }[];
  anti_patterns: string[];
  verification_checklist: string[];
}

/** A design variant with rendered HTML, used by the design gallery feature. */
export interface DesignVariant {
  name: string;
  description: string;
  html: string;
  filePath?: string;
}

// --- Orchestrator Loop Types (#174) ---

export type OrchestratorAction =
  | { type: "CONTINUE" }
  | { type: "PAUSE"; reason: string }
  | { type: "REASSIGN"; stepIndex: number; newTeam: string; reason: string }
  | { type: "SKIP_STEP"; stepIndex: number; reason: string }
  | { type: "SPAWN_TEAM"; team: string; task: string; reason: string }
  | { type: "ESCALATE_TO_USER"; message: string };

export type OrchestratorTrigger =
  | "periodic"
  | "user_message"
  | "agent_done"
  | "stall_detected"
  | "severity_alert"
  | "budget_warning";

export interface SessionStateEvent {
  phase: string;
  active_leads: string[];
  progress: number;
  current_step: number;
  total_steps: number;
  assessment: string;
  session_status: "active" | "paused" | "completed" | "error";
  budget_percent: number;
  actions: string[];
  last_updated: string;
}
export type AgentStatus = "idle" | "running" | "done" | "error" | "blocked";
export type GradeLevel = "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED" | "UNGRADED";

export interface SkillRef {
  path: string;
  "use-when"?: string;
}

export interface PersonaConfig {
  name: string;
  model: string;
  expertise: string;
  max_expertise_lines?: number;
  skills: (string | SkillRef)[];
  tools: string[];
  domain: DomainConfig;
  body?: string;
}

export interface DomainConfig {
  read: string[];
  write: string[];
  update: string[];
  delete?: string[];
}

export interface TeamMember {
  name: string;
  path: string;
  model: string;
  color: string;
  "consult-when"?: string;
}

export interface TeamConfig {
  "team-name": string;
  "team-color": string;
  "consult-when": string;
  lead: TeamMember;
  members: TeamMember[];
}

export interface TeamsFile {
  orchestrator: TeamMember & { path: string };
  teams: TeamConfig[];
}

export type TillDoneVerifyType = "output_match" | "deterministic" | "llm_verified";

export interface ParallelTeamStep {
  team: string;
  read_only?: boolean;
  lead_only?: boolean;
  strict_spawn?: boolean;
  tools_override?: string[];
  system_prompt_append?: string;
  till_done?: (string | { text: string; type: TillDoneVerifyType; verify?: string })[];
  max_worker_retries?: number;
  on_feedback?: {
    retry_team: string;
    max_attempts: number;
    escalate_to: string;
  };
}

export interface ChainStep {
  team?: string;
  agent?: string;
  parallel?: ParallelTeamStep[];
  read_only?: boolean;
  lead_only?: boolean;
  strict_spawn?: boolean;
  deterministic?: {
    command: string;
    on_failure?: "loop" | "fail" | "continue";
    max_retries?: number;
    label?: string;
  };
  tools_override?: string[];
  system_prompt_append?: string;
  till_done?: (string | { text: string; type: TillDoneVerifyType; verify?: string })[];
  max_worker_retries?: number;
  on_feedback?: {
    retry_team: string;
    max_attempts: number;
    escalate_to: string;
  };
}

export interface Chain {
  description: string;
  steps: ChainStep[];
  parallel?: ParallelTeamStep[];
  then?: ChainStep[];
}

export interface ChainsFile {
  chains: Record<string, Chain>;
}

export interface PromptConfig {
  description: string;
  "argument-hint": string;
  chain?: string;
}

export interface SessionEvent {
  session_id: string;
  agent_id: string;
  parent_id?: string;
  event_type: string;
  timestamp: string;
  tokens_used?: number;
  cost_usd?: number;
  context_tokens?: number;
  data: Record<string, unknown>;
}

export interface SessionState {
  id: string;
  name: string;
  chain: string;
  task: string;
  workingDir: string;
  status: "active" | "paused" | "completed" | "error";
  abortSignal?: AbortSignal;
  agents: Map<string, AgentState>;
  tillDone: TillDoneItem[];
  events: SessionEvent[];
  totalCost: number;
  totalTokens: number;
  startedAt: Date;
}

export interface AgentState {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  teamName: string;
  teamColor: string;
  parentId?: string;
  status: AgentStatus;
  costUsd: number;
  tokensUsed: number;
  contextTokens: number;
}

export interface TillDoneItem {
  description: string;
  completed: boolean;
  active: boolean;
  type: TillDoneVerifyType;
  verify?: string;
  evidence?: string;
}

export interface WorkerReview {
  workerId: string;
  workerName: string;
  grade: "PASS" | "NEEDS_WORK";
  feedback?: string;
  reworkedPrompt?: string;
  directFix?: string;
  qualityNotes?: string[];
  spawnSr?: boolean;
  srDomains?: string[];
}

export interface DelegateResult {
  agentId: string;
  agentName: string;
  output: string;
  grade?: GradeLevel;
  findings?: string[];
  qualityNotes?: string[];
  reviews?: WorkerReview[];
  outputArtifact?: string;
  taskReport?: string;
  costUsd: number;
  tokensUsed: number;
}

export interface PlatformAdapter {
  name: string;
  delegate(opts: DelegateOptions): Promise<DelegateResult>;
  isAvailable(): Promise<boolean>;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface TierConfig {
  default: string;
  default_thinking: string;
  options?: { model: string; thinking: string; note?: string }[];
  context?: number;
}

export interface RoleDefault {
  tier: string;
  thinking: ThinkingLevel;
}

export interface ConcurrencyConfig {
  max_concurrent_agents: number;
  max_concurrent_per_team: number;
}

export interface RatchetConfig {
  min_golden_coverage?: number;
  max_cost_multiplier?: number;
  max_judge_regression?: number;
  judge_model?: string;
  judge_ratchet_model?: string;
  judge_max_traces_per_run?: number;
  judge_cache_days?: number;
  require_langfuse_scores?: boolean;
}

export interface ModelRoutingConfig {
  tiers: Record<string, TierConfig>;
  aliases?: Record<string, string>;
  models?: Record<string, { primary: string }>;
  roleDefaults: Record<string, RoleDefault>;
  modelOverrides?: Record<string, { thinking?: ThinkingLevel }>;
  crossModelPairs?: { builder: string; verifier: string }[];
  budgets?: { max_per_session_usd: number; warn_at_usd: number; max_per_agent_usd: number; max_total_tokens: number; budget_action?: "warn" | "pause" };
  concurrency?: ConcurrencyConfig;
  ratchet?: RatchetConfig;
}

export interface StreamEvent {
  type: "tool_call" | "tool_result" | "assistant_text" | "cost";
  tool?: string;
  filePath?: string;
  toolArgs?: string;
  toolResult?: string;
  status?: string;
  content?: string;
  final?: boolean;
  costUsd?: number;
  tokensUsed?: number;
  cacheReadTokens?: number;
}

export interface DelegateOptions {
  persona: PersonaConfig;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  thinking: ThinkingLevel;
  tools: string[];
  domain: DomainConfig;
  workingDir: string;
  sessionDir: string;
  maeAgentId?: string;
  maeAgentName?: string;
  parentId?: string;
  teamName: string;
  teamColor: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onStreamEvent?: (event: StreamEvent) => void;
  sendMessage?: (fn: (msg: string) => void) => void;
}
