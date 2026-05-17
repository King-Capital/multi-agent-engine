import { createLogger } from "./logger";

const log = createLogger("messaging");

/**
 * Route only explicit @mentions to agents.
 *
 * Freeform dashboard steer messages are handled by the orchestrator loop and
 * should not be injected into whichever worker happens to be active.
 */
export function sendUserMessage(
  messageSenders: Map<string, (msg: string) => void>,
  sessionId: string,
  message: string,
  targetAgentId?: string,
): void {
  if (targetAgentId && targetAgentId !== "orchestrator") {
    const sender = messageSenders.get(`${sessionId}:${targetAgentId}`);
    if (sender) {
      log.info("Targeted message to agent", { session_id: sessionId, agent: targetAgentId, preview: message.slice(0, 80) });
      sender(message);
      return;
    }
    log.warn("No active agent matching structured target", { session_id: sessionId, agent: targetAgentId });
    return;
  }

  if (message.startsWith("@")) {
    const prefix = `${sessionId}:`;
    // Match longest registered agent name from the @mention
    let bestMatch: { agentKey: string; sender: (msg: string) => void; rest: string } | null = null;

    for (const [key, sender] of messageSenders) {
      if (!key.startsWith(prefix)) continue;
      const agentSlug = key.slice(prefix.length);
      // Try matching "@code reviewer ..." or "@code-reviewer ..."
      const variants = [agentSlug.replace(/-/g, " "), agentSlug];
      for (const v of variants) {
        if (message.toLowerCase().startsWith(`@${v.toLowerCase()}`)) {
          const rest = message.slice(v.length + 1).trim(); // +1 for @
          if (!bestMatch || v.length > bestMatch.agentKey.length) {
            bestMatch = { agentKey: v, sender, rest };
          }
        }
      }
    }

    if (bestMatch) {
      bestMatch.rest = bestMatch.rest.replace(/^[:\s]+/, "");
      log.info("Targeted message to agent", { session_id: sessionId, agent: bestMatch.agentKey, preview: bestMatch.rest.slice(0, 80) });
      bestMatch.sender(bestMatch.rest);
      return;
    }
    log.warn("No active agent matching @mention", { session_id: sessionId, mention_preview: message.slice(0, 50) });
  }

  log.info("Freeform steer message left with orchestrator", { session_id: sessionId, preview: message.slice(0, 80) });
}

/**
 * Broadcast explicit control messages such as !stop to every active agent in a
 * session. This intentionally bypasses normal freeform routing so cancellation
 * commands still reach workers.
 */
export function broadcastControlMessage(
  messageSenders: Map<string, (msg: string) => void>,
  sessionId: string,
  message: string,
): number {
  const prefix = `${sessionId}:`;
  let delivered = 0;

  for (const [key, sender] of messageSenders) {
    if (!key.startsWith(prefix)) continue;
    try {
      sender(message);
    } catch (err) {
      log.warn("Control message sender failed", {
        session_id: sessionId,
        agent: key.slice(prefix.length),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    delivered++;
  }

  log.info("Broadcast control message to active agents", {
    session_id: sessionId,
    delivered,
    preview: message.slice(0, 80),
  });
  return delivered;
}

/**
 * Start listening for user messages via SSE stream from the dashboard.
 * Returns an AbortController to stop listening.
 */
export function listenForUserMessages(
  dashboardUrl: string,
  sessionId: string,
  onMessage: (sessionId: string, content: string, messageId?: string, targetAgentId?: string) => void,
): AbortController {
  const abort = new AbortController();
  if (dashboardUrl.trim() === "" || dashboardUrl === "off" || process.env.MAE_DISABLE_DASHBOARD === "1") {
    return abort;
  }

  const baseUrl = `${dashboardUrl}/api/sessions/${sessionId}/stream`;
  const BASE_RETRY_MS = 3_000;
  const MAX_RETRY_MS = 60_000;
  let retryDelay = BASE_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeReader: { cancel: () => Promise<void> } | null = null;
  let lastEventId: string | undefined;
  const seenMessageIds = new Set<string>();

  abort.signal.addEventListener("abort", () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    void activeReader?.cancel().catch(() => {});
    activeReader = null;
  });

  const scheduleReconnect = (delay: number) => {
    if (abort.signal.aborted) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (abort.signal.aborted) return;
    const apiToken = process.env.MAE_API_TOKEN;
    const headers: Record<string, string> = {};
    if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    const url = lastEventId ? `${baseUrl}?last_event_id=${encodeURIComponent(lastEventId)}` : baseUrl;
    fetch(url, { signal: abort.signal, headers: Object.keys(headers).length > 0 ? headers : undefined }).then(async (res) => {
      if (!res.ok || !res.body) {
        if (!abort.signal.aborted) {
          log.warn("SSE connection returned non-OK response, retrying", { session_id: sessionId, status: res.status, retry_delay_ms: retryDelay });
          scheduleReconnect(retryDelay);
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
        }
        return;
      }
      const reader = res.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentId = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let lineEnd: number;
          while ((lineEnd = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);

            if (line.startsWith("id:")) {
              currentId = line.slice(3).trim();
            } else if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:") && currentEvent === "message") {
              try {
                const evt = JSON.parse(line.slice(5));
                if (evt.data?.from === "user" && evt.data?.content) {
                  const messageId = typeof evt.data.message_id === "string" ? evt.data.message_id : undefined;
                  const dedupeKey = messageId ?? `${currentId}:${evt.data.content}`;
                  if (seenMessageIds.has(dedupeKey)) continue;
                  seenMessageIds.add(dedupeKey);
                  log.info("User message received", { session_id: sessionId, preview: evt.data.content.slice(0, 80) });
                  onMessage(sessionId, evt.data.content, messageId, evt.data.to);
                }
              } catch { /* not JSON */ }
            } else if (line === "") {
              if (currentId) lastEventId = currentId;
              currentEvent = "";
              currentId = "";
            }
          }
        }
      } finally {
        if (activeReader === reader) activeReader = null;
      }

      if (!abort.signal.aborted) {
        retryDelay = BASE_RETRY_MS;
        log.info("SSE stream ended, reconnecting", { session_id: sessionId, retry_delay_ms: retryDelay });
        scheduleReconnect(retryDelay);
      }
    }).catch((err) => {
      if (abort.signal.aborted) return;
      log.warn("SSE connection failed, retrying", { session_id: sessionId, retry_delay_ms: retryDelay, error: err.message ?? String(err) });
      scheduleReconnect(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    });
  };

  connect();
  return abort;
}

/**
 * Stop listening for user messages.
 */
export function stopListening(abort: AbortController | null): void {
  abort?.abort();
}
