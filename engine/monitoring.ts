export interface AgentActivity {
  agentId: string;
  name: string;
  role: string;
  lastEventAt: number;
  toolCalls: number;
  lastTool: string;
  warned: boolean;
}

export const IDLE_WARN_MS = 90_000;
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

/**
 * Start the agent activity monitor. Logs idle warnings and periodic heartbeats.
 * Returns the interval handle for cleanup.
 */
export function startMonitor(
  agentActivity: Map<string, AgentActivity>,
  _sessionId: string,
): ReturnType<typeof setInterval> {
  let tick = 0;
  return setInterval(() => {
    const now = Date.now();
    tick++;
    const isHeartbeat = tick % 2 === 0;

    for (const [id, a] of agentActivity) {
      const idle = now - a.lastEventAt;

      if (idle > IDLE_WARN_MS && !a.warned) {
        console.warn(`[monitor] IDLE: ${a.name} (${id}) -- ${Math.round(idle / 1000)}s`);
        a.warned = true;
      }

      if (isHeartbeat) {
        const status = idle > IDLE_WARN_MS ? "idle" : "working";
        console.log(`[heartbeat] ${a.name} (${a.role}): ${status} | ${a.toolCalls} tools | last: ${a.lastTool || "none"} | idle: ${Math.round(idle / 1000)}s`);
      }
    }
  }, MONITOR_INTERVAL_MS);
}

/**
 * Stop the agent activity monitor and clear all tracked activity.
 */
export function stopMonitor(
  monitorInterval: ReturnType<typeof setInterval> | null,
  agentActivity: Map<string, AgentActivity>,
): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
  }
  agentActivity.clear();
}
