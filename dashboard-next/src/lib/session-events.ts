import type { DBEvent, LiveEvent, SessionStatus } from "@/lib/types";

function payloadAsLiveEvent(event: DBEvent): Partial<LiveEvent> {
  const payload = event.payload;
  if (payload && typeof payload === "object" && "event_type" in payload) {
    return payload as Partial<LiveEvent>;
  }
  return {};
}

export function dbEventToLiveEvent(event: DBEvent): LiveEvent {
  const payload = payloadAsLiveEvent(event);
  return {
    session_id: payload.session_id ?? event.session_id,
    agent_id: payload.agent_id ?? event.agent_id ?? "",
    parent_id: payload.parent_id,
    event_type: payload.event_type ?? event.event_type,
    timestamp: payload.timestamp ?? event.created_at,
    tokens_used: payload.tokens_used,
    cost_usd: payload.cost_usd,
    context_tokens: payload.context_tokens,
    data: payload.data ?? {},
  };
}

export function mergeSessionEvents(historyEvents: DBEvent[], liveEvents: LiveEvent[]): LiveEvent[] {
  const merged: LiveEvent[] = [];
  const seen = new Set<string>();
  for (const event of [...historyEvents.map(dbEventToLiveEvent), ...liveEvents]) {
    const messageId = event.data?.message_id ?? event.data?.ack_for;
    const key = messageId
      ? `${event.event_type}:${event.agent_id}:${messageId}`
      : `${event.event_type}:${event.agent_id}:${event.timestamp ?? ""}:${event.data?.content ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.sort((a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime());
}

export function deriveSessionStatus(events: LiveEvent[], fallback: SessionStatus): SessionStatus {
  let status: SessionStatus = fallback;
  for (const event of events) {
    if (event.event_type === "session_state" && typeof event.data?.session_status === "string") {
      status = normalizeSessionStatus(event.data.session_status, status);
    } else if (event.event_type === "pause") {
      status = "paused";
    } else if (event.event_type === "resume") {
      status = "active";
    } else if (event.event_type === "session_end") {
      status = "completed";
    } else if (event.event_type === "error") {
      status = "error";
    }
  }
  return status;
}

function normalizeSessionStatus(value: string, fallback: SessionStatus): SessionStatus {
  switch (value) {
    case "active":
    case "paused":
    case "completed":
    case "error":
    case "deleted":
      return value;
    default:
      return fallback;
  }
}
