# Focused Re-review: Phase 2 Final Consolidation Delta

Branch: `pi-phase2-participant-presence`  
Scope reviewed: diff from `70af71c` excluding `.pi/skills/*` and `.idea/*`  
Result: **PASS**

## Findings Table

| Severity | File:Line | Finding | Suggested fix |
|---|---:|---|---|
| — | — | No material in-scope Critical/High/Medium/P3 blockers found. | None. |

## Acceptance Matrix

| Check | Result | Evidence |
|---|---|---|
| Participant status vocabulary is `starting|active|idle|stale|completed|failed|blocked` | PASS | `ParticipantStatus` is normalized in `engine/types.ts`; `participantEnd`/`agentDone` now emit `completed|failed|blocked`; `findStaleParticipants` treats `completed|failed|blocked` as terminal. Grep found no in-scope lingering participant `ended|error|offline` statuses; remaining `error` references are unrelated session/agent concepts or prior review docs. |
| Rich `ParticipantCapabilities` are safe and bounded | PASS | Capabilities include model, booleans, authority, tool names, and domain/read/write globs only. `EventEmitter` redacts capability records defensively. No tool args/results or secret-bearing values are threaded into capabilities. |
| Capabilities threaded through real spawn paths | PASS | Covered in orchestrator spawn, lead spawn, worker spawn, retry worker spawn, Sr. agent spawn, synthesis spawn, and solo chain `runAgent` spawn. |
| Activity/current tool remains emitted from `toolCall` | PASS | `EventEmitter.toolCall` still calls `participantActivity` with `currentTool`, `currentTask`, and `lastEvent: "tool_call"` before emitting the tool event. |
| Heartbeat remains transition/bounded | PASS | No new heartbeat interval source added. Heartbeats remain emitted through lifecycle/cost/activity event paths. Existing monitor interval is stall detection, not heartbeat spam. |
| `participant_stale` emitted only from existing ActiveMonitor stall detection | PASS | New stale emission is in `ActiveMonitor` immediately beside existing `stallDetected`; grep found no additional `participantStale` producer in engine code beyond tests and the emitter method. |
| Claude `ParticipantTracker` not included/unused | PASS | No `ParticipantTracker` implementation/import in engine code; only planning/review docs mention it as deferred. |
| Trace schema/docs describe final behavior | PASS | `specs/trace-schema.md` documents rich capabilities, activity, bounded heartbeat, stale, and terminal statuses `completed|failed|blocked`. |
| Tests meaningful / no obvious type/API compatibility regression | PASS | Existing tests were updated to assert stale-on-stall, participant status normalization, and capability propagation. Known validation reports targeted bundle, full `bun test`, typecheck, cert smoke, and diff-check all passing. |

## Material blockers before PR update

None.
