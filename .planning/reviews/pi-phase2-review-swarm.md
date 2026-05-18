# Phase 2 Participant Presence Review Swarm

Branch: `pi-phase2-participant-presence`  
Scope: Phase 2 participant presence/heartbeat diff only; excluded pre-existing `.pi/skills/*.md` and `.idea/` dirt.  
Result: **FAIL** — material P3 lifecycle/acceptance gaps remain before PR.

## Findings

| ID | Severity | Perspective | File:Line | Finding | Concrete reasoning / reproduction | Suggested fix |
|---|---:|---|---|---|---|---|
| F1 | P3 | Correctness / lifecycle semantics | `engine/event-emitter.ts:247-255`, `engine/orchestrator.ts:267-273`, `engine/event-emitter.ts:285-294` | Orchestrator emits duplicate `participant.start` events for the same `orch-1` participant. | `sessionStart()` now emits `participantStart(sessionId, "orch-1", ...)`, then every normal session immediately calls `agentSpawn(sessionId, "orch-1", ...)`, which emits a second `participant_start` for the same participant ID before any end. A presence consumer keyed by participant ID will see a restarted participant and may reset metadata/heartbeat state; a consumer keyed by event stream will show duplicate orchestrator starts. | Emit the orchestrator participant in exactly one place. Prefer making `agentSpawn("orch-1")` the canonical orchestrator start, or teach `sessionStart()` not to emit participant presence. Add a test for one `participant_start` per orchestrator session. |
| F2 | P3 | Adversarial / trace-evidence gap | `engine/team-execution.ts:323-337`, `engine/team-execution.ts:817-832` | Normal multi-worker leads never emit `participant.end`, so lead presence remains active/stale after successful team completion. | The only `agentDone(leadId)` path is the early-return branch for failed/lead-only/no-worker teams. In the normal team path, `runTeamStep()` does lead review, builds the result, sends the completion message, and returns without `agentDone()`/`participantEnd()` or `untrackActivity(leadId)`. Reproduce with any non-lead-only team with members: the lead emits `participant_start` and heartbeat via `costUpdate`, but no `participant_end`. This creates false stale/offline evidence for successful leads. | After lead review/final result in the normal path, emit lead completion (`agentDone` or at least `participantEnd`) and untrack lead activity. Add a test covering a standard team with workers and asserting lead start/end bracketing. |
| F3 | P3 | MAE domain / participant-kind semantics | `engine/team-execution.ts:972-973`, `engine/event-emitter.ts:28-30`, `engine/event-emitter.ts:285-292` | Synthesis participants are typed as `orchestrator`, not `synthesis`, despite the new participant kind and schema. | Parallel synthesis uses `agentSpawn(..., "Synthesis", "orchestrator", ...)`. `participantKindForRole()` maps role `orchestrator` to kind `orchestrator`, so the emitted participant has `kind:"orchestrator"`, `role:"orchestrator"`, and `current_task:"agent:orchestrator"`. The new type/schema explicitly reserve `synthesis` as a participant kind, so dashboard/presence views cannot distinguish the synthesis actor from the real orchestrator. | Pass/derive `kind:"synthesis"` for the synthesis agent, or extend `agentSpawn` with an explicit participant kind override. Add an event-emitter/team-execution test for synthesis participant metadata. |

## Convergence / acceptance matrix

| Acceptance item | Status | Notes |
|---|---|---|
| Participant types | Partial | Types include orchestrator/lead/worker/sr/synthesis/validator/web-steer/cli-steer/system, but synthesis is not emitted as `kind:"synthesis"` (F3). |
| `participant.start/activity/heartbeat/stale/end` helpers | Pass | Helpers exist on `EventEmitter`; tests cover direct helper emission. |
| Trace recording for participant events | Pass | `EventEmitter` logs `trace_type: participant.*`; `trace-recorder` maps and extracts participant fields; tests cover start/heartbeat/stale. |
| Bounded heartbeat semantics | Pass | Heartbeats are emitted on cost/activity/lifecycle transitions, not via an unbounded timer. |
| Orchestrator instrumentation through EventEmitter methods | Partial | Instrumented, but duplicate `orch-1` starts violate lifecycle semantics (F1). |
| Lead instrumentation through EventEmitter methods | Fail | Leads start/heartbeat, but normal multi-worker leads do not end (F2). |
| Worker instrumentation through EventEmitter methods | Pass | Worker spawn/cost/done paths bracket participant events. |
| Current tool/activity updates where stream tool calls are available | Pass | `buildStreamHandler` routes tool events through `emitter.toolCall()`, which emits participant activity. |
| Capability metadata | Pass | Start events include bounded capability metadata; redaction applied through logger/emitter redaction paths. |
| Stale/offline helper and tests | Partial | Stale helper and tests exist. Offline/terminal policy is represented only by `ended/error`; F2 means successful leads can become falsely stale. |
| Trace schema docs | Pass | `specs/trace-schema.md` documents participant events and bounded heartbeat volume. |
| Validation docs | Pass | Phase 2 validation snapshots are documented. |

## Validation notes

Commands run from `/Volumes/ThunderBolt/Development/ai-agents/platforms/multi-agent-engine`:

- `bun test engine/event-emitter.test.ts engine/trace-recorder.test.ts engine/participant-presence.test.ts engine/team-execution.test.ts` — **PASS** (62 pass, 0 fail).
- `just check` — **PASS** (`cd engine && bunx tsc --noEmit`).
- I also ran `bunx tsc --noEmit` from the repository root; it exited 1 by printing TypeScript help because this repo's configured check must run from `engine/`. This is an invocation issue, not a Phase 2 type failure; `just check` is the relevant gate and passed.

## Review dirt exclusions

Ignored as requested: pre-existing `.pi/skills/*.md` modifications and untracked `.idea/` files.
