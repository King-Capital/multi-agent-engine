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
    console.warn(
      `[session-state] Rejected status transition: ${current} → ${newStatus} (source: ${source}, session: ${session.id ?? "unknown"})`,
    );
    return false;
  }
  session.status = newStatus;
  console.log(`[session-state] Status: ${current} → ${newStatus} (source: ${source})`);
  return true;
}
