# Phase 2 Participant Presence / Heartbeat — Second Re-review

Result: **FAIL** — prior findings are closed, but one new material P3 dashboard compatibility blocker remains.

Not promoting because: this was a one-off code review workflow; no repeated reusable command/process emerged.

## Prior-finding closure table

| Finding | Status | Evidence |
|---|---:|---|
| F1 duplicate orchestrator `participant.start` | CLOSED | `engine/event-emitter.ts:247-258` `sessionStart()` emits only `session_start`; canonical orchestrator participant start is via `agentSpawn()` at `engine/orchestrator.ts:267-273` and `engine/event-emitter.ts:279-303`. Regression test at `engine/event-emitter.test.ts:224-238`. |
| F2 normal multi-worker lead terminal lifecycle | CLOSED | `runTeamStep()` now emits `agentDone()` and untracks the lead after final result at `engine/team-execution.ts:823-833`; early-return paths already terminate/untrack in `delegateToLead()` at `engine/team-execution.ts:326-334`. |
| F3 synthesis kind | CLOSED | Synthesis spawn passes explicit override at `engine/team-execution.ts:978-979`; `agentSpawn()` uses the override for `kind` and `current_task` at `engine/event-emitter.ts:279-288`. |
| R1 duplicate `orch-1` `participant_end` | CLOSED | `agentDone("orch-1")` remains the only orchestrator terminal participant source at `engine/orchestrator.ts:315-323`; `sessionEnd()` now only updates/emits session status at `engine/event-emitter.ts:515-526`. Regression test at `engine/event-emitter.test.ts:380-396`. |

## New findings

| ID | Severity | File:line | Finding | Reasoning | Suggested fix |
|---|---:|---|---|---|---|
| R2-P3-1 | P3 / Medium | `dashboard-next/src/lib/api.ts:206-227`, `dashboard-next/src/lib/api.ts:254-259`; server emits named SSE at `dashboard/handlers_session.go:351-359` | New participant events are emitted as named SSE events but the React dashboard does not subscribe to those event names. | Phase 2 adds `participant_start`, `participant_activity`, `participant_heartbeat`, `participant_stale`, and `participant_end` in `engine/event-emitter.ts:62-113`, but `subscribeToSession()` only registers known names in `SSE_EVENT_TYPES`. Because the Go SSE writer sends `event: <evt.EventType>`, these are not delivered through `onmessage`; browsers dispatch them only to matching named listeners. Result: persisted/trace semantics work, but live dashboard consumers miss participant presence/heartbeat updates until refresh or API polling, undermining the Phase 2 visibility path. | Add the five participant event names to `SSE_EVENT_TYPES` and a focused frontend/API test or smoke coverage proving a `participant_heartbeat` named frame reaches `onEvent`. |

## Acceptance matrix

| Area | Status | Notes |
|---|---:|---|
| Orchestrator start semantics | PASS | `sessionStart()` no longer starts a participant; `agentSpawn("orch-1")` is canonical. |
| Orchestrator terminal semantics | PASS | `sessionEnd()` is session-only; no duplicate `participant_end` after `agentDone("orch-1")`. |
| Sessions ending without orchestrator `agentDone` | PASS | Normal `run()` path initializes `orchestratorLoop` before execution and `stopAndDrain()` returns a cost summary even with zero cycles, so `agentDone("orch-1")` should emit before `sessionEnd()`. |
| Normal lead lifecycle | PASS | Normal multi-worker path now terminates/untracks lead; early lead-only/failure paths remain covered. |
| Synthesis participant kind/current task | PASS | Explicit `synthesis` override is wired. |
| Duplicate terminal events | PASS | No duplicate terminal event found in current orchestrator shutdown path after R1. |
| Cost snapshots | PASS | `costUpdate()` emits participant heartbeat snapshots; `agentDone()` emits final participant cost snapshot. No regression found. |
| Trace semantics | PASS | Trace recorder maps participant lifecycle/heartbeat events and carries bounded participant fields. |
| Dashboard compatibility | **FAIL** | Live named SSE subscription omits participant event names. |
| Test quality | PASS with gap | Backend/engine regression coverage is targeted and useful; add dashboard/SSE coverage for R2-P3-1. |

## Validation notes

Reviewed the actual current diff with `.pi/skills/*` and `.idea/*` excluded. I did not edit implementation files and did not rerun the full validation suite; known post-R1 validation remains as provided (`67 pass`, `just check` PASS, diff check PASS). The only blocking issue found in this second re-review is R2-P3-1 above.
