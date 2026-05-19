# Standard Swarm v2 Decision Log

Canonical PRD: `../standard-swarm-v2-prd-workflow.md`

Use this file to record implementation decisions during future goal sessions.

## Existing planning decisions

### D-001 — v2 before v2.1

Decision:

Implement Standard Swarm v2 production hardening first. Defer A2A, scoped sub-buses, authority-weighted peer conflict resolution, and peer challenge until after a post-v2 evidence gate.

Reason:

The foundation must prove lifecycle, observability, validation, spawn discipline, and steer traceability before adding peer communication complexity.

### D-002 — Validator is deterministic first

Decision:

Validator/verifier must check trace/artifact evidence deterministically. LLM commentary may be optional but cannot override deterministic evidence checks.

Reason:

Validator should prevent drift from evidence, not become another opinion agent.

### D-003 — Practical validation, not routine live swarms

Decision:

Use targeted tests and local full verification bundles for each phase. Do not run full live Pi swarms as routine validation. Live Pi requires explicit user approval and is milestone-only.

Reason:

Live swarms are expensive, slow, noisy, and unsuitable as normal feedback loops.

### D-004 — Structured workflow per phase

Decision:

Every phase follows Scope → Tasks → Implementation → Lint/Type/Test → Fixes.

Reason:

This reduces drift and makes phase completion auditable.

### D-005 — Docs are source of truth

Decision:

Use the PRD/execution docs as the default basis for implementation decisions. Keep docs updated as work progresses. Do not rethink or rewrite working code paths without evidence and an explicit decision entry.

Reason:

The docs exist to reduce drift and prevent agents from repeatedly re-litigating already-working parts of MAE.

### D-006 — Observed failures become regressions

Decision:

Every observed certification/orchestration failure that reaches manual debugging must become a regression fixture/test before the fix is considered complete, when practical.

Reason:

MAE has repeatedly rediscovered failures such as missing lead lifecycle, empty output artifacts, and scope drift. Regression tests prevent recurrence.

### D-007 — Older certification foundation issues are v2 prerequisites

Decision:

Treat #288, #318, #319, #320, #321, #322, #323, and #326 as certification-foundation inputs to Standard Swarm v2, not unrelated backlog. Phase 0 must triage them, Phase 1 must absorb open lifecycle/parser/artifact/contract blockers, and Phase 3 must absorb open validator/contract-boundary blockers.

Reason:

The v2 plan depends on trusted certification evidence. These older issues describe known ways certification can false-pass or false-fail, so omitting them would make the v2 execution packet incomplete.

## Future decisions template

### D-008 — Certification runs are lead-only

Date: 2026-05-18
Phase: 1
Issue(s): #330

Decision:

When `MAE_CERTIFICATION_MODE=1`, all teams run in lead-only mode (no worker spawning). Leads review the fixture directly.

Reason:

Full worker swarms on minimal certification fixtures are wasteful (~$2/run for a single README), produce empty outputs from agents with nothing to do, and create operational failures that obscure the actual certification result. Leads are sufficient for fixture review.

Alternatives considered:

- Worker count limits per team (more complex, still spawns some unnecessary agents)
- Separate cert chain without workers (duplicates chain config)

Impact:

Cert runs are ~5x cheaper and ~3x faster. Harness checks for 5 lead completions instead of 5 worker spawns + 5 lead reviews.

Validation required:

- `scripts/certify-live-swarm-test`
- Live Pi cert run with lead-only mode

### D-009 — Separate operational from substantive trace failures

Date: 2026-05-18
Phase: 1
Issue(s): #322, #323

Decision:

`trace_has_operational_failures` checks only for session.end errors, agent.error, worker_failed, and error events. Individual agent FAILED grades are NOT operational failures — they are substantive outcomes handled by empty output checks and certification contract validation.

Reason:

Conflating operational failures (session crash) with substantive failures (agent graded FAILED) prevented the harness from reaching contract validation. The certification contract is the authority on pass/fail.

### D-010 — Chain runner does not throw on degraded cert steps

Date: 2026-05-18
Phase: 1
Issue(s): #330

Decision:

In certification mode, chain steps with FEEDBACK/FAILED grades are logged as "degraded" instead of "failed" and do not throw. The session completes, and the cert harness evaluates the evidence.

Reason:

Cert mode runs once without retries. Throwing on FEEDBACK prevents the session from completing and the synthesis from producing a certification contract.

### D-011 — Fresh final consolidation branch from main

Date: 2026-05-18
Phase: 1
Issue(s): #330, #318, #319, #320, #321, #322, #323, #326

Decision:

Create final PR branch `pi-phase1-complete` fresh from `main` and port the converged implementation as Pi base + Codex hardening gates + Claude runtime fixes. Do not merge agent branches wholesale.

Reason:

All six cross-reviews agreed on the same merge path, but source worktrees had different strengths and hygiene risks. A fresh branch avoids unrelated main-checkout dirt and makes final validation evidence attributable to one exact state.

Alternatives considered:

- Use Pi source branch directly: rejected because final branch should start from `main` and explicitly port accepted deltas.
- Use Claude consolidation branch: rejected because branch naming and ownership should follow the agreed Pi base.
- Blind-merge all worktrees: rejected because it could pull rejected or duplicate changes.

Impact:

Final PR contains only the accepted Phase 1 implementation, planning/review evidence, and regression harness updates.

Validation required:

- `scripts/certify-live-swarm-test`
- `bun test engine/team-execution.test.ts`
- `just check`
- `bun test`
- `scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"`
- `git diff --check`
- Optional but desired final milestone: approved full live Pi all-fixture certification from `pi-phase1-complete`

### D-2026-05-18-P2 — Phase 2 consolidation source selection

Date: 2026-05-18
Phase: 2 — Participant presence/heartbeat
Issue(s): #331

Decision:

Use Pi PR #356 as the canonical Phase 2 base, then manually cherry-pick low-risk Codex runtime completeness improvements: richer participant capability metadata at real spawn sites, retry/Sr./solo spawn coverage, stale emission from existing stall detection, and status normalization to `starting|active|idle|stale|completed|failed|blocked`. Do not merge Codex or Claude branches wholesale. Do not include Claude's standalone ParticipantTracker in Phase 2.

Reason:

Pi is already committed, pushed, reviewed to PASS, and fully validated. Codex adds useful runtime metadata and stale-on-existing-stall behavior that strengthens Phase 2 without adding a second source of truth. Claude's tracker is useful design material but is not wired; including it now would create ambiguous participant state ownership before Phase 3/6 validator/dashboard decisions.

Alternatives considered:

- Merge all three branches: rejected because it duplicates concepts and risks conflicting lifecycle semantics.
- Use Codex branch as base: rejected because Pi already passed full review/PR gates.
- Include Claude ParticipantTracker now: rejected because it is standalone and not the single source of truth.

Impact:

Final Phase 2 PR remains Pi-based and adds only targeted runtime completeness improvements. Participant terminal status vocabulary is normalized for dashboard/validator consumers.

Validation required:

- Targeted participant/event tests
- `scripts/certify-live-swarm-test`
- `scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"`
- `bun test`
- `cd engine && bunx tsc --noEmit`
- `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'`
- Focused re-review of Codex cherry-picks

### D-2026-05-19-P4 — Strict spawn decisions precede worker creation

Date: 2026-05-19
Phase: 4 — Structured spawn decisions
Issue(s): #340

Decision:

Use explicit lead-authored `SPAWN_DECISION` blocks as the only strict-mode authorization for worker creation. Strict mode is enabled by `strict_spawn: true`, `MAE_SPAWN_DECISION_STRICT=1`, `MAE_STANDARD_SWARM_V2_STRICT=1`, or `MAE_CERTIFICATION_MODE=1`. A valid matching decision is emitted as a `spawn_decision` dashboard event and `spawn.decision` trace event before `agent_spawn`; `main_bus` remains rejected until the v2.1 sub-bus design exists. Compatibility aliases from earlier branch work are accepted at parser/validator boundaries and canonicalized into the flat Phase 4 schema.

Reason:

Worker creation must be auditable before it happens. Synthetic decisions or post-spawn validation would prove that a worker existed, but not that the lead explicitly justified it before execution.

Alternatives considered:

- Synthesizing default decisions in legacy mode: rejected for strict evidence because it weakens the lead-authored contract.
- Emitting decisions after `agent_spawn`: rejected because the trace should show authorization before creation.
- Enabling `main_bus` now: rejected because scoped sub-buses are v2.1/RFC scope.

Impact:

Legacy non-strict runs keep existing worker behavior and emit decision events only when the lead provided explicit `SPAWN_DECISION` blocks. Strict runs reject missing or invalid decisions before any worker spawn. Worker prompts are derived from the structured decision when present.

Validation required:

- `bun test engine/spawn-decision.test.ts engine/team-execution.test.ts engine/event-emitter.test.ts engine/trace-recorder.test.ts engine/certification-validator.test.ts`
- `scripts/certify-live-swarm-test`
- `just check`
- `git diff --check`

### D-XXX — Title

Date:
Phase:
Issue(s):

Decision:

Reason:

Alternatives considered:

Impact:

Validation required:
