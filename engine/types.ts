export type AgentRole = "orchestrator" | "lead" | "worker";
export type AgentStatus = "idle" | "running" | "done" | "error" | "blocked";
export type GradeLevel = "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED";

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

export interface ChainStep {
  team?: string;
  agent?: string;
  parallel?: { team: string }[];
  deterministic?: {
    command: string;
    on_failure?: "loop" | "fail" | "continue";
    max_retries?: number;
    label?: string;
  };
  till_done?: string[];
  on_feedback?: {
    retry_team: string;
    max_attempts: number;
    escalate_to: string;
  };
}

export interface Chain {
  description: string;
  steps: ChainStep[];
  parallel?: { team: string }[];
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
  status: "active" | "completed" | "error";
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
}

export interface DelegateResult {
  agentId: string;
  agentName: string;
  output: string;
  grade?: GradeLevel;
  findings?: string[];
  costUsd: number;
  tokensUsed: number;
}

export interface PlatformAdapter {
  name: string;
  delegate(opts: DelegateOptions): Promise<DelegateResult>;
  isAvailable(): Promise<boolean>;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface StreamEvent {
  type: "tool_call" | "tool_result" | "assistant_text" | "cost";
  tool?: string;
  filePath?: string;
  toolArgs?: string;
  toolResult?: string;
  status?: string;
  content?: string;
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
  parentId?: string;
  teamName: string;
  teamColor: string;
  timeoutMs?: number;
  onStreamEvent?: (event: StreamEvent) => void;
  sendMessage?: (fn: (msg: string) => void) => void;
}
