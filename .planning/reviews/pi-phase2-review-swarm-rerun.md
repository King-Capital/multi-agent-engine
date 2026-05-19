# Phase 2 Participant Presence Re-review

Result: **FAIL** — prior findings F1-F3 are fixed, but one new in-scope P3 regression remains: `orch-1` can receive duplicate `participant_end` terminal events on normal session shutdown.

## Prior-finding closure table

| ID | Status | Evidence | Notes |
|---|---|---|---|
| F1 duplicate orchestrator participant.start | CLOSED | `engine/event-emitter.ts:247-259` `sessionStart()` emits only `session_start`; canonical orchestrator participant start is `agentSpawn()` at `engine/orchestrator.ts:270-273` via `engine/event-emitter.ts:279-290`. Test coverage at `engine/event-emitter.test.ts:224-236`. | No duplicate `participant_start` from session start path found. |
| F2 normal multi-worker lead terminal lifecycle | CLOSED | Normal `runTeamStep()` now calls `agentDone()` for the lead at `engine/team-execution.ts:829-832` and `untrackActivity()` at `engine/team-execution.ts:833` after final result construction. `agentDone()` emits `participant_end` then `agent_done` at `engine/event-emitter.ts:306-327`. Test coverage at `engine/team-execution.test.ts:731-777`. | The specific normal multi-worker path is covered and fixed. |
| F3 synthesis participant kind/current_task | CLOSED | `runParallelStep()` passes explicit kind override at `engine/team-execution.ts:978-979`; `agentSpawn()` uses the override and sets `currentTask: agent:${kind}` at `engine/event-emitter.ts:279-288`. Test coverage at `engine/event-emitter.test.ts:240-253` and `engine/team-execution.test.ts:780-785`. | Synthesis emits `kind: synthesis` and `current_task: agent:synthesis`. |

## New blocking findings

| ID | Severity | File:Line | Finding | Concrete reasoning | Suggested fix |
|---|---|---:|---|---|---|
| R1 | P3 / Medium | `engine/orchestrator.ts:315-327`, `engine/event-emitter.ts:515-527` | `orch-1` receives duplicate `participant_end` terminal events. | `stopAndDrain()` always returns a cost summary object, so `orchestrator.ts:317-322` calls `agentDone("orch-1", ...)`, which emits `participant_end` at `event-emitter.ts:311-315`. Immediately afterward `sessionEnd()` calls `participantEnd(sessionId, "orch-1", ...)` again at `event-emitter.ts:520` before emitting `session_end`. This violates the participant lifecycle invariant and can confuse trace/dashboard presence reducers that expect one terminal transition per participant. | Make `orch-1` termination single-source. Prefer keeping `agentDone("orch-1")` as the canonical participant/agent terminal event and remove/guard the `sessionEnd()` `participantEnd()` call, or make `sessionEnd()` only emit the orchestrator participant end when no orchestrator `agentDone` was emitted. Add a regression test asserting exactly one `participant_end` for `orch-1` during normal shutdown. |

## Acceptance matrix

| Area | Status | Notes |
|---|---|---|
| F1 closure | PASS | `sessionStart()` no longer starts `orch-1`. |
| F2 closure | PASS | Normal multi-worker lead result now emits terminal lifecycle and untracks. |
| F3 closure | PASS | Synthesis kind override is wired through to participant metadata. |
| Event ordering | FAIL | Normal orchestrator shutdown emits two terminal participant events: one through `agentDone`, one through `sessionEnd`. |
| Trace semantics | FAIL | Duplicate `participant.end` records for `orch-1` create ambiguous terminal state/history. |
| Dashboard compatibility | FAIL | Presence reducers may double-process `orch-1` terminal state and display duplicate close events. |
| Duplicate terminal events | FAIL | R1. |
| Cost accounting surprises | PASS | No direct double-add to `session.totalCost`; participant heartbeat/end cost snapshots are event metadata only. |
| Test quality | FAIL | Good targeted coverage for F1-F3, but no end-to-end normal session shutdown assertion for unique `orch-1` terminal lifecycle. |

## Validation notes

- Reviewed actual current diff directly with `.pi/skills/*` and `.idea/*` excluded.
- Did not edit implementation files.
- Known validation supplied by caller is noted but not independently rerun for this review.
- Untracked `engine/participant-presence.ts` and `engine/participant-presence.test.ts` were included in review because they are part of the Phase 2 diff.
