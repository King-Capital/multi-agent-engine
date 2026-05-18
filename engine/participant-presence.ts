import type { ParticipantState } from "./types";

export interface StaleParticipant {
  participantId: string;
  reason: string;
  idleMs: number;
}

function timestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function findStaleParticipants(
  participants: Iterable<ParticipantState>,
  now: Date,
  staleAfterMs: number,
): StaleParticipant[] {
  const nowMs = now.getTime();
  const stale: StaleParticipant[] = [];

  for (const participant of participants) {
    if (participant.status === "completed" || participant.status === "failed" || participant.status === "blocked") continue;
    const lastHeartbeatMs = timestampMs(participant.last_heartbeat_ts) ?? timestampMs(participant.started_at);
    if (lastHeartbeatMs === null) {
      stale.push({
        participantId: participant.participant_id,
        reason: "missing participant heartbeat timestamp",
        idleMs: staleAfterMs,
      });
      continue;
    }

    const idleMs = nowMs - lastHeartbeatMs;
    if (idleMs >= staleAfterMs) {
      stale.push({
        participantId: participant.participant_id,
        reason: `no activity for ${idleMs}ms`,
        idleMs,
      });
    }
  }

  return stale;
}
