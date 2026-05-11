import { createLogger } from "./logger";

const log = createLogger("session-state");

export type SessionStatus = "active" | "paused" | "completed" | "error";

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  active: ["paused", "completed", "error"],
  paused: ["active", "completed", "error"],
  completed: [],  // terminal — nothing can overwrite
  error: [],      // terminal — nothing can overwrite
};

export function transitionStatus(
  session: { status: string; id?: string },
  newStatus: SessionStatus,
  source: string,
): boolean {
  const current = session.status as SessionStatus;
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed || !allowed.includes(newStatus)) {
    log.warn("Rejected status transition", { from: current, to: newStatus, source, session_id: session.id ?? "unknown" });
    return false;
  }
  session.status = newStatus;
  log.info("Status transition", { from: current, to: newStatus, source, session_id: session.id });
  return true;
}
