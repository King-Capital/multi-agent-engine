# Phase 2 Participant Presence — Third Re-review (R3)

**Branch:** `pi-phase2-participant-presence`  
**Scope reviewed:** current Phase 2 participant presence/heartbeat diff only; excluded pre-existing `.pi/skills/*.md` and `.idea/` dirt.  
**Result:** PASS

I inspected the actual current diff and relevant untracked Phase 2 files. I found no material in-scope Critical/High/Medium/P3 blockers.

## Prior-finding closure table

| Finding | Status | Evidence |
|---|---:|---|
| F1 duplicate orchestrator `participant.start` | CLOSED | `sessionStart()` now emits only `session_start` (`engine/event-emitter.ts:247-258`); canonical orchestrator participant start is via `agentSpawn()` → `participantStart()` (`engine/event-emitter.ts:261-290`). Regression asserts one `orch-1` start (`engine/event-emitter.test.ts:224-237`). |
| F2 normal multi-worker lead terminal lifecycle | CLOSED | Normal `runTeamStep()` now calls `agentDone()` for the lead and untracks it after final team result (`engine/team-execution.ts:823-833`). Regression covers multi-worker lead completion/untrack (`engine/team-execution.test.ts:735-776`). |
| F3 synthesis `kind` / `current_task` | CLOSED | Parallel synthesis spawn passes explicit `"synthesis"` participant kind (`engine/team-execution.ts:976-979`), and `agentSpawn()` uses `currentTask: agent:${kind}` (`engine/event-emitter.ts:279-288`). Regression verifies `kind: synthesis` and `current_task: agent:synthesis` (`engine/event-emitter.test.ts:240-251`). |
| R1 duplicate `orch-1` `participant_end` | CLOSED | `agentDone()` is the terminal participant source (`engine/event-emitter.ts:306-315`); `sessionEnd()` now emits only `session_end` and updates session status (`engine/event-emitter.ts:515-526`). Regression asserts exactly one `orch-1` `participant_end` while still emitting `session_end` (`engine/event-emitter.test.ts:384-395`). |
| R2 dashboard named SSE subscription | CLOSED | Frontend SSE type list includes all participant event names (`dashboard-next/src/lib/api.ts:206-215`) and `subscribeToSession()` registers named listeners for every type (`dashboard-next/src/lib/api.ts:259-265`). Regression proves a named `participant_heartbeat` frame reaches consumers (`dashboard-next/test/api-sse.test.ts:44-64`). |

## New findings

| Severity | File:line | Finding | Suggested fix |
|---|---|---|---|
| — | — | No material in-scope Critical/High/Medium/P3 findings. | — |

## Acceptance matrix

| Area | Status | Notes |
|---|---:|---|
| Dashboard TypeScript/test quality | PASS | New EventSource mock is small and restores `globalThis.EventSource` after each test (`dashboard-next/test/api-sse.test.ts:7-40`); test validates named participant delivery and cleanup (`dashboard-next/test/api-sse.test.ts:44-64`). |
| EventSource mock validity | PASS | Mock implements constructor capture, `addEventListener`, and `close`; dispatch path invokes registered named listeners with `MessageEvent` data, matching `subscribeToSession()`'s consumption path. |
| Event naming consistency | PASS | Dashboard/SSE uses underscore names (`participant_start`, etc.) while trace logging converts to dotted trace types (`eventType.replace(/_/g, ".")`) before trace recorder ingestion (`engine/event-emitter.ts:101-112`). Trace recorder accepts dotted participant types (`engine/trace-recorder.ts:50-52`, `engine/trace-recorder.ts:108-115`). |
| Backend/frontend compatibility | PASS | Go SSE writer emits `event: ${evt.EventType}` for named events; frontend now subscribes to matching participant names. No enum gate was found in the Go SSE path. |
| Trace semantics | PASS | Participant trace fields are mapped explicitly, including `participant_id`, `kind`, `status`, heartbeat timestamp, cost/tokens, capabilities, and bounded task/reason strings (`engine/trace-recorder.ts:151-170`). |
| Duplicate lifecycle events | PASS | Starts, normal lead endings, synthesis kind, and orchestrator end duplication have targeted code paths and regressions as noted above. |
| Stale detection | PASS | Helper ignores terminal participants and reports stale/missing-heartbeat active participants (`engine/participant-presence.ts:23-41`), with focused tests (`engine/participant-presence.test.ts:15-40`). |
| Validation status | PASS (per provided evidence) | Known post-R2 validation: targeted tests 68 pass, certification harness 36 checks pass, echo cert smoke pass, full `bun test` 568 pass/1 skip, `just check` pass, diff check pass. I did not rerun validation in this read-only review. |

## Validation notes

- Actual diff inspected with `git diff HEAD -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` plus direct reads of new untracked Phase 2 files (`dashboard-next/test/api-sse.test.ts`, `engine/participant-presence.ts`, `engine/participant-presence.test.ts`).
- Review intentionally did not edit source files.
- Remaining low/info consideration only: frontend `SSEEvent` union in `dashboard-next/src/lib/types.ts` does not enumerate participant variants, but `subscribeToSession()` exposes `LiveEvent` and current consumers are not blocked; this is not a material P3 for Phase 2 acceptance.
