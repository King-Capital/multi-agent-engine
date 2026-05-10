export interface AgentActivity {
  agentId: string;
  name: string;
  role: string;
  lastEventAt: number;
  toolCalls: number;
  lastTool: string;
  warned: boolean;
}

export const IDLE_WARN_MS = 180_000;
export const MONITOR_INTERVAL_MS = 15_000;

/**
 * Track a new agent's activity. Initializes the activity entry.
 */
export function trackActivity(
  agentActivity: Map<string, AgentActivity>,
  agentId: string,
  name: string,
  role: string,
): void {
  agentActivity.set(agentId, {
    agentId, name, role,
    lastEventAt: Date.now(),
    toolCalls: 0,
    lastTool: "",
    warned: false,
  });
}

/**
 * Record a tool call for an agent, resetting idle tracking.
 */
export function trackToolCall(
  agentActivity: Map<string, AgentActivity>,
  agentId: string,
  tool: string,
): void {
  const a = agentActivity.get(agentId);
  if (a) {
    a.lastEventAt = Date.now();
    a.toolCalls++;
    a.lastTool = tool;
    a.warned = false;
  }
}

