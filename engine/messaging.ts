/**
 * Route a user message to the correct agent by @mention matching,
 * or broadcast to the first available sender in the session.
 */
export function sendUserMessage(
  messageSenders: Map<string, (msg: string) => void>,
  sessionId: string,
  message: string,
): void {
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
      console.log(`[orchestrator] Targeted message to ${bestMatch.agentKey}: ${bestMatch.rest.slice(0, 80)}`);
      bestMatch.sender(bestMatch.rest);
      return;
    }
    console.warn(`[orchestrator] No active agent matching @mention in: ${message.slice(0, 50)}`);
  }

  // Broadcast to first available sender
  for (const [key, sender] of messageSenders) {
    if (key.startsWith(sessionId)) {
      sender(message);
      return;
    }
  }
}

/**
 * Start listening for user messages via SSE stream from the dashboard.
 * Returns an AbortController to stop listening.
 */
export function listenForUserMessages(
  dashboardUrl: string,
  sessionId: string,
  onMessage: (sessionId: string, content: string) => void,
): AbortController {
  const abort = new AbortController();
  const url = `${dashboardUrl}/api/sessions/${sessionId}/stream`;
  const BASE_RETRY_MS = 3_000;
  const MAX_RETRY_MS = 60_000;
  let retryDelay = BASE_RETRY_MS;

  const connect = () => {
    if (abort.signal.aborted) return;
    fetch(url, { signal: abort.signal }).then(async (res) => {
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let lineEnd: number;
        while ((lineEnd = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);

          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:") && currentEvent === "message") {
            try {
              const evt = JSON.parse(line.slice(5));
              if (evt.data?.from === "user" && evt.data?.content) {
                console.log(`[orchestrator] User message: ${evt.data.content.slice(0, 80)}`);
                onMessage(sessionId, evt.data.content);
              }
            } catch { /* not JSON */ }
          } else if (line === "") {
            currentEvent = "";
          }
        }
      }

      if (!abort.signal.aborted) {
        retryDelay = BASE_RETRY_MS;
        console.log(`[orchestrator] SSE stream ended, reconnecting in ${retryDelay}ms`);
        setTimeout(connect, retryDelay);
      }
    }).catch((err) => {
      if (abort.signal.aborted) return;
      console.warn(`[orchestrator] SSE connection failed, retrying in ${retryDelay}ms:`, err.message ?? err);
      setTimeout(connect, retryDelay);
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
