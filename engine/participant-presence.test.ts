import { describe, expect, test } from "bun:test";
import { findStaleParticipants } from "./participant-presence";
import type { ParticipantState } from "./types";

function participant(overrides: Partial<ParticipantState>): ParticipantState {
  return {
    participant_id: "p1",
    kind: "worker",
    status: "active",
    name: "Worker",
    ...overrides,
  };
}

describe("participant presence stale detection", () => {
  test("reports active participants beyond the stale threshold", () => {
    const stale = findStaleParticipants([
      participant({ participant_id: "lead-1", last_heartbeat_ts: "2026-05-18T00:00:00.000Z" }),
      participant({ participant_id: "worker-1", last_heartbeat_ts: "2026-05-18T00:00:55.000Z" }),
    ], new Date("2026-05-18T00:01:00.000Z"), 30_000);

    expect(stale).toEqual([{ participantId: "lead-1", reason: "no activity for 60000ms", idleMs: 60_000 }]);
  });

  test("ignores terminal participants", () => {
    const stale = findStaleParticipants([
      participant({ participant_id: "done-1", status: "ended", last_heartbeat_ts: "2026-05-18T00:00:00.000Z" }),
      participant({ participant_id: "error-1", status: "error", last_heartbeat_ts: "2026-05-18T00:00:00.000Z" }),
    ], new Date("2026-05-18T00:01:00.000Z"), 30_000);

    expect(stale).toEqual([]);
  });

  test("reports active participants missing heartbeat timestamps", () => {
    const stale = findStaleParticipants([
      participant({ participant_id: "unknown-1" }),
    ], new Date("2026-05-18T00:01:00.000Z"), 30_000);

    expect(stale).toEqual([{ participantId: "unknown-1", reason: "missing participant heartbeat timestamp", idleMs: 30_000 }]);
  });
});
