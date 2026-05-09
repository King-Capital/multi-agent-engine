/**
 * Pi Dashboard Bridge Extension
 * 
 * Streams tool calls, cost updates, and messages from Pi sub-agents
 * to the MAE dashboard. Picks up session context from env vars set
 * by the MAE orchestrator when spawning Pi RPC sessions.
 * 
 * Env vars (set by orchestrator):
 *   MAE_DASHBOARD_URL  - Dashboard HTTP endpoint (set in ~/.mae/config)
 *   MAE_API_TOKEN      - Auth token for dashboard API
 *   MAE_SESSION_ID     - Parent session ID to attach events to
 *   MAE_AGENT_ID       - This agent's ID in the session
 *   MAE_PARENT_ID      - Parent agent ID (for sub-agent hierarchy)
 */

const DASHBOARD_URL = process.env.MAE_DASHBOARD_URL;
const API_TOKEN = process.env.MAE_API_TOKEN;
const SESSION_ID = process.env.MAE_SESSION_ID;
const AGENT_ID = process.env.MAE_AGENT_ID ?? "pi-subagent";
const PARENT_ID = process.env.MAE_PARENT_ID ?? "";

// Queue + flush pattern to avoid hammering the dashboard
let eventQueue: Record<string, unknown>[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 500;

async function flushEvents(): Promise<void> {
  if (!DASHBOARD_URL || !SESSION_ID || eventQueue.length === 0) return;
  
  const batch = eventQueue.splice(0, eventQueue.length);
  
  for (const evt of batch) {
    try {
      await fetch(`${DASHBOARD_URL}/api/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
        },
        body: JSON.stringify(evt),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Don't let dashboard failures break the agent
    }
  }
}

function enqueueEvent(evt: Record<string, unknown>): void {
  eventQueue.push(evt);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushEvents();
    }, FLUSH_INTERVAL_MS);
  }
}

function emit(eventType: string, data: Record<string, unknown> = {}): void {
  enqueueEvent({
    session_id: SESSION_ID,
    agent_id: AGENT_ID,
    parent_id: PARENT_ID,
    event_type: eventType,
    timestamp: new Date().toISOString(),
    data,
  });
}

// @ts-ignore -- Pi extension API
export default function (pi: any) {
  if (!DASHBOARD_URL || !SESSION_ID) {
    // No dashboard context -- skip silently
    return;
  }

  console.log(`[dashboard-bridge] Connected to dashboard`);

  // Track tool calls
  pi.on("tool_call", async (event: any) => {
    if (event.tool === "bash" || event.tool === "read" || event.tool === "write" ||
        event.tool === "grep" || event.tool === "find") {
      const args = event.input ?? {};
      const filePath = (args.file_path ?? args.path ?? args.command ?? "").toString().slice(0, 500);
      emit("tool_call", {
        tool: event.tool,
        file_path: filePath,
        tool_status: "running",
      });
    }
  });

  // Track tool results
  pi.on("tool_result", async (event: any) => {
    emit("tool_call", {
      tool: event.toolName ?? "unknown",
      tool_status: event.isError ? "error" : "success",
    });
  });

  // Track cost/token updates
  pi.on("message", async (event: any) => {
    const msg = event.message;
    if (msg?.role === "assistant" && msg?.usage) {
      const usage = msg.usage;
      const cost = usage.cost?.total ?? 0;
      const tokens = usage.totalTokens ?? 0;
      if (cost > 0 || tokens > 0) {
        enqueueEvent({
          session_id: SESSION_ID,
          agent_id: AGENT_ID,
          event_type: "cost_update",
          timestamp: new Date().toISOString(),
          cost_usd: cost,
          tokens_used: tokens,
          context_tokens: usage.contextWindow ?? 0,
          data: {},
        });
      }
    }
  });

  // Flush on session end
  pi.on("session_shutdown", async () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flushEvents();
    emit("agent_done", { grade: "unknown" });
    await flushEvents();
  });
}
