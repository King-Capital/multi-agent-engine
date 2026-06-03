# PRD / Workflow Plan: Standard Swarm v2 Production Hardening

## Status

Planning only. Do **not** start an implementation/goal session from this document automatically.

## Parent issue set

- #288 — P0: make MAE core orchestration contracts mechanically enforced
- #318 — P0: Define MAE production swarm certification contract
- #319 — P0: Emit strict machine-readable swarm final output
- #320 — P0: Fix live certification canonical artifact lookup
- #321 — P0: Replace regex-only swarm verification with structured contract validation
- #322 — P1: Certification harness must fail on failed teams/session errors
- #323 — P1: Add certification parser and harness false-pass/false-fail tests
- #326 — P1: Avoid CERTIFICATION_CONTRACT prompt conflicts in swarm squads
- #329 — Plan: model web steer as participant and adapt Pi-to-Pi peer-agent patterns
- #330 — P0: Add lifecycle evidence gates to live swarm certification
- #331 — P1: Add participant presence and heartbeat trace state
- #332 — P1: Add dashboard agent pool / participant status view
- #333 — P2: Add bounded session-local A2A primitives
- #334 — P2: Add optional cross-team peer challenge phase for swarm-review
- #335 — P1: Add first-class validator/verifier for certification evidence
- #337 — P2: Add authority-weighted conflict resolution for Standard Swarm v2
- #338 — P1: Model web steer as high-authority traceable participant
- #339 — P2: Add scoped sub-buses for lead-owned Sr/worker groups
- #340 — P1: Require structured spawn decisions before leads create workers

Related design note:

- `.planning/standard-swarm-v2-flat-leads.md`

## Executive summary

Standard Swarm v2 evolves MAE's proven standard swarm pattern. It keeps the five specialist lead perspectives but first focuses on making the existing process trustworthy, observable, and less noisy.

The v2 production-hardening scope is:

1. lifecycle-based certification gates
2. participant presence/heartbeat state
3. first-class deterministic validator/verifier
4. structured worker spawn decisions
5. traceable high-authority web/CLI steer
6. dashboard agent pool observability

The v2.1 collaboration RFC scope is deferred until v2 evidence shows it is needed:

1. bounded session-local A2A primitives
2. scoped sub-buses for lead-owned Sr./worker groups
3. authority-weighted conflict resolution
4. optional peer challenge phase

The intended end state is:

> standard swarm roles + lifecycle evidence gates + participant presence + validator + lead-first worker spawning + high-authority traceable web steer + dashboard observability.

The possible v2.1 end state, if justified by real runs, is:

> v2 foundation + bounded lead communication + scoped worker sub-buses + authority-weighted conflict resolution.

## Non-goals for the first implementation wave

- Do not implement cross-device HTTP/SSE agent hub yet.
- Do not make certification fully flat/peer-to-peer.
- Do not allow unrestricted agent-to-agent chat.
- Do not allow workers on the main lead bus by default.
- Do not allow web steer to silently override evidence failures.
- Do not replace the existing standard swarm before comparative evaluation.
- Do not build A2A, sub-buses, authority conflict resolution, or peer challenge until a post-v2 decision gate proves those solve observed production problems.

## Product goals

### Goal 1 — Make certification evidence trustworthy

A production cert run must prove the process completed correctly, not just output a plausible final contract.

### Goal 2 — Make live swarm state observable

Operators should be able to answer “what is each lead/worker doing?” from the dashboard and trace, without manual jq archaeology.

### Goal 3 — Reduce agent noise and cost

Shift from worker-heavy default spawning toward lead-owned work and explicit specialist escalation.

### Goal 4 — Enable bounded lead collaboration

Deferred to v2.1. Only pursue this if v2 observability shows real lead-to-lead collaboration failures that dashboard steer, validator evidence, and structured spawn decisions do not solve.

### Goal 5 — Preserve human/operator control as auditable authority

Web/CLI steer should be high-authority participants whose actions are traceable and certification-impacting.

## Core concepts

### Participant

A first-class actor in a MAE session:

- orchestrator
- lead
- worker
- synthesis
- validator
- web-steer
- cli-steer
- system

### Lifecycle gate

A deterministic evidence check over trace/artifacts/session state.

### Validator

A verifier that checks final claims/contracts against evidence. Reviewers judge the target; validators judge the review process.

### Main lead bus

A bounded communication channel between the five lead roles. Deferred to v2.1 unless the post-v2 decision gate approves lead collaboration work.

### Sub-bus

A scoped communication channel owned by a lead for Sr./worker groups. Deferred to v2.1.

### Authority

A numeric/domain-specific conflict weight. In v2, authority applies to auditable web/CLI steer. In v2.1, authority may also decide who must be rebutted in peer challenges; evidence still decides what is true, and the validator decides if final claims are supported.

## Phased implementation plan

---

# Phase 0 — Baseline and branch hygiene

## Purpose

Prepare for implementation without mixing unrelated live-cert hardening or `.pi/skills` dirt.

## Issues

- Supports all issues, with explicit preflight for certification-foundation issues #288, #318, #319, #320, #321, #322, #323, and #326.

## Tasks

1. Confirm branch strategy.
2. Confirm current changed files and unrelated dirt.
3. Decide whether to continue on `fix/live-certification-hardening` or create a dedicated branch after current work is committed/stashed.
4. Record baseline live cert behavior and known failure modes.
5. Ensure no old live cert runs are active.
6. Triage the certification-foundation issues and decide whether each is:
   - already resolved and ready to close
   - a Phase 1 prerequisite
   - a Phase 3 validator prerequisite
   - intentionally deferred with documented reason

## Acceptance criteria

- Working tree state is understood.
- No unrelated `.pi/skills/*.md` changes are included in implementation commits.
- Baseline known failures are documented.
- Certification-foundation issue mapping is recorded before Phase 1 starts.

## Verification

- `git status --short --branch`
- `ps`/trace check for stale live cert runs if relevant

---

# Phase 1 — Lifecycle evidence gates

## Primary issue

- #330

## Supporting certification-foundation issues

- #288 — mechanically enforced orchestration contracts
- #318 — production certification contract definition
- #319 — strict machine-readable swarm final output
- #320 — canonical final artifact lookup
- #321 — structured contract validation instead of regex-only verification
- #322 — failed team/session errors fail certification
- #323 — parser and harness false-pass/false-fail tests
- #326 — synthesis-only `CERTIFICATION_CONTRACT`; squads emit `REVIEW_REPORT`

## Purpose

Make live swarm certification fail closed on bad lifecycle evidence.

## Dependencies

None. This can start before full participant presence exists, using existing trace events and artifact scans.

## Tasks

1. Define certification lifecycle evidence schema.
2. Extend current cert harness checks for:
   - all expected teams delegated
   - worker spawn/review evidence according to the active mode policy:
     - current standard swarm: all five leads spawned workers where required
     - lead-first mode: leads either spawned justified workers or emitted valid `need_worker: false` decisions
   - all five leads completed their required lead review lifecycle:
     - current worker mode: lead spawned/reviewed required workers
     - lead-first mode: lead completed direct review and emitted valid `need_worker: false`, or spawned/reviewed justified workers
   - no `ERROR: Empty output` artifacts
   - no trace agent/session failures
   - no scope drift outside current `mae-cert.*` workdir
   - no wrong fixture reads
   - canonical final artifact exists
   - final certification contract validates
   - failed teams/session errors fail certification
   - squad outputs do not spoof or replace synthesis-only `CERTIFICATION_CONTRACT`
3. Add fixtures/tests for each failure class.
4. Replace production certification decisions based on broad prose/regex matching with structured contract validation.
5. If still in bash, keep logic minimal and clearly mark future TS extraction.
6. Add follow-up task stub for `engine/certification-evidence.ts` extraction.

## Acceptance criteria

- A run with missing Security lead lifecycle completion fails, whether that lifecycle is direct lead review or post-worker review.
- A run violating the active mode's worker/spawn policy fails.
- A run with empty worker/orchestrator artifact fails.
- A run with tool args referencing previous `mae-cert.*` fails.
- A run reading a sibling fixture fails.
- A run with failed teams/session errors fails.
- A run with missing/malformed/partial certification contract fails.
- A squad-level `CERTIFICATION_CONTRACT` conflict fails or is ignored in favor of synthesis-only contract rules.
- Echo cert smoke still passes.
- Test harness covers failure cases.

## Verification

- `scripts/certify-live-swarm-test`
- targeted cert harness fixture tests
- echo `scripts/certify-live-swarm --only failing --dashboard-url "$MAE_DASHBOARD_URL"`

## Exit gate

Do not proceed to live production cert claims until lifecycle gates pass locally and in echo smoke.

---

# Phase 2 — Participant presence and heartbeat trace state

## Primary issue

- #331

## Supporting issues

- #338 future web-steer participant
- #332 dashboard consumer
- #330 stale/offline cert gate consumer

## Purpose

Make all MAE actors visible as participants with lifecycle/status/activity state.

## Tasks

1. Add participant/presence types.
2. Add event emitter helpers:
   - `participant.start`
   - `participant.activity`
   - `participant.heartbeat`
   - `participant.stale`
   - `participant.end`
3. Emit participant start/end for:
   - orchestrator
   - team leads
   - workers
   - synthesis/validator later
4. Emit activity/current tool from adapter tool-call paths where available.
5. Add participant capability metadata sufficient for later policy checks:
   - allowed control actions for web/CLI steer
   - allowed communication actions for leads/workers
   - model/provider/tool capability hints where available
6. Add stale detection policy:
   - active but no activity after threshold => stale
   - terminal event clears active state
7. Add heartbeat volume policy:
   - emit activity events for meaningful state/tool changes
   - emit heartbeat snapshots on a bounded monitor cadence, with lifecycle/cost transitions also refreshing participant heartbeat state
   - do not stream high-frequency tick events into trace/Langfuse
8. Update trace schema docs.
9. Add tests for state transitions.

## Acceptance criteria

- Trace can reconstruct all active participants.
- Every lead/worker has start and terminal event.
- Long-running participants produce heartbeat/activity.
- Stale/offline state is trace-visible.
- Lifecycle cert gate can consume stale/offline evidence.

## Verification

- `bun test` targeted presence/event tests
- inspect sample trace JSONL
- cert harness still passes echo tests

## Exit gate

A sample swarm trace must answer: who was active, what were they doing, and who ended/staled/failed.

---

# Phase 3 — First-class validator/verifier

## Primary issue

- #335

## Supporting issue

- #330 lifecycle evidence source
- #318 production certification contract definition
- #319 strict machine-readable final output
- #321 structured contract validation
- #322 failed teams/session errors
- #323 false-pass/false-fail parser tests
- #326 certification prompt/output boundary

## Purpose

Introduce an evidence-first validation layer after synthesis.

## Tasks

1. Define `VALIDATION_CONTRACT` schema.
2. Implement deterministic validator checks first:
   - lifecycle evidence complete
   - scope valid
   - no empty outputs
   - no stale/offline participants
   - team-level structured contracts present and schema-valid where required
   - review squads emit valid `REVIEW_REPORT` blocks where required
   - `CERTIFICATION_CONTRACT` is synthesis-only
   - final contract matches lifecycle facts
   - canonical artifact matches trace
3. Add validator step to certification chain or harness path.
4. Ensure validator is not opinion-only; it must cite trace/artifact evidence.
5. Keep pass/fail deterministic. Any LLM validator commentary is optional, non-authoritative, and cannot override evidence checks.
6. Add tests for contradiction cases.

## Acceptance criteria

- Validator catches a final synthesis that says ready while lifecycle evidence fails.
- Validator catches missing lead review.
- Validator catches scope drift.
- Validator catches missing or invalid team-level structured contracts where required.
- Validator catches prompt/output boundary violations between squad `REVIEW_REPORT` and synthesis `CERTIFICATION_CONTRACT`.
- Validator emits machine-readable `VALIDATION_CONTRACT`.
- Production cert can require validator success when enabled.

## Verification

- targeted validator unit tests
- cert fixture tests
- echo cert smoke

## Exit gate

A certification run cannot pass if validator contract is failed/missing in strict mode.

---

# Phase 4 — Structured worker spawn decisions

## Primary issue

- #340

## Supporting issues

- #331 participant state
- #335 validator
- #339 future sub-buses

## Purpose

Make worker spawning explicit, justified, scoped, and auditable. This is part of v2 because it addresses current cost/noise/scope-drift risk without requiring A2A or peer messaging.

## Tasks

1. Define `SPAWN_DECISION` schema.
2. Require leads to emit spawn decision before spawning Sr./workers.
3. Generate worker prompts from the spawn decision:
   - scope
   - allowed tools
   - forbidden paths
   - expected output schema
   - bus policy
   - timeout
4. Support `need_worker: false` for lead-owned work.
5. Validator checks worker spawn decisions in strict/cert mode.
6. Add metrics comparing default worker swarm vs lead-first.

## Acceptance criteria

- Worker spawn has a machine-readable decision.
- Missing constraints fail in strict mode.
- Worker prompts are tight and derived from the decision.
- Unjustified default worker spawning can be disabled for Standard Swarm v2.

## Verification

- worker lifecycle tests
- prompt generation tests
- strict-mode spawn validation tests

## Exit gate

No worker exists in Standard Swarm v2 strict mode without a valid spawn decision.

---

# Phase 5 — Web steer as high-authority participant

## Primary issue

- #338

## Supporting issues

- #329 umbrella
- #331 participant state
- #330 cert intervention gate
- #332 dashboard pool
- #335 validator

## Purpose

Make dashboard/web steer a high-authority participant whose actions are traceable and certification-impacting.

## Tasks

1. Add `web-steer` and `cli-steer` participant kinds.
2. Add default authority:
   - web-steer: 90
   - cli-steer: 90
3. Convert dashboard steer operations into trace events:
   - sender
   - authority
   - intent/action
   - target
   - reason
   - certification impact
4. Add certification mode semantics:
   - unattended: no steer events allowed
   - interactive: steer events allowed but recorded
5. Validator checks steer events did not hide evidence failures.

## Acceptance criteria

- Web steer appears in participant state/dashboard data.
- Web steer messages are trace events.
- Unattended cert fails on unexpected web steer.
- Interactive cert records steer event count/effects.
- Authority adjustments are auditable.

## Verification

- backend steer API tests
- trace event tests
- cert mode tests

## Exit gate

No dashboard control action is invisible to trace/certification.

---

# Phase 6 — Dashboard agent pool

## Primary issue

- #332

## Dependencies

- Phase 2 participant presence
- Phase 5 web steer participant for full scope, though basic agent pool can start earlier

## Purpose

Expose live participant state in dashboard.

## Tasks

1. Add dashboard backend endpoint:
   - `GET /api/sessions/:id/participants`
2. Decide the source of truth before implementation by inspecting both current dashboard paths:
   - live SSE/event reconstruction
   - persisted history/aggregate queries
3. Derive participant snapshots from trace/event state without creating a second incompatible status model.
4. Add React agent pool component.
5. Show:
   - name
   - kind
   - team/role
   - model/provider
   - status
   - current task/tool
   - last event
   - heartbeat age
   - cost/tokens
   - stale/blocked marker
6. Add certification badges:
   - teams spawned
   - lead reviews completed
   - empty outputs
   - stale participants
   - scope drift
   - steer events
7. Link rows to trace/artifacts where possible.

## Acceptance criteria

- User can see whether Security Lead is active, stale, reviewing, or done.
- Missing lead-review cycle is visible.
- Stale/blocked state is highlighted.
- Web steer appears as participant after Phase 5.

## Verification

- dashboard API tests
- React component tests if available
- manual/visual verification via dashboard

## Exit gate

Dashboard can answer the “did Security Lead do anything?” question without jq.

---

## Decision gate — v2 complete / v2.1 RFC required

After Phases 1-6 ship, stop before building A2A, sub-buses, authority conflict resolution, or peer challenge. Run real standard swarm and lead-first swarm sessions with the new lifecycle gates, participant state, validator, spawn decisions, steer traceability, and dashboard observability.

Proceed to v2.1 only if observed evidence shows that the remaining problems are caused by lack of bounded lead-to-lead collaboration, not by missing evidence, loose worker prompts, dashboard visibility, or operator steer.

### Decision questions

- Do real runs show missed issues because leads cannot challenge each other?
- Are lead outputs contradictory often enough to require conflict machinery?
- Did structured spawn decisions solve most cost/noise/scope drift?
- Is dashboard/operator steer enough for the observed workflow failures?
- Are the extra cost, latency, and nondeterminism of messaging worth it?

### Required evidence

- sample traces from current standard swarm and lead-first mode
- validator evidence reports
- dashboard screenshots or API snapshots showing participant state
- cost/latency comparison
- list of concrete failures that v2.1 primitives would address

### Exit criteria

- If evidence does not justify v2.1, keep Phases 7-10 as deferred RFC material.
- If evidence does justify v2.1, open or update a separate v2.1 RFC and execute it as a separate program.

---

# Phase 7 — Session-local A2A primitives

## Primary issue

- #333

## Dependencies

- Phase 2 participant presence
- Phase 3 validator useful but not strictly required

## Purpose

Add bounded session-local participant messaging without cross-device networking.

## Tasks

1. Implement session-scoped message bus.
2. Add primitives:
   - `participant_list`
   - `participant_send`
   - `participant_get`
   - `participant_await`
3. Add message model:
   - msg id
   - session id
   - from/to
   - conversation id
   - status
   - hops
   - timeout/expiry
   - response schema
4. Add guardrails:
   - max hops
   - max messages/session
   - max messages/participant
   - required timeout
   - optional/required response schema
   - no human/web target unless policy allows
5. Trace all message lifecycle events.
6. Add tests for loops, timeout, schema failure, and session escape prevention.

## Acceptance criteria

- Messages cannot leave session scope.
- Message lifecycle is trace-visible.
- Loops terminate.
- Cert mode can disable A2A or allow only configured peer challenge.

## Verification

- message bus unit tests
- trace tests
- policy tests

## Exit gate

A2A is safe enough to support a bounded challenge phase.

---

# Phase 8 — Scoped sub-buses for Sr./worker groups

## Primary issue

- #339

## Dependencies

- Phase 7 A2A primitives
- Phase 4 spawn decisions

## Purpose

Allow worker groups to communicate without polluting the main lead bus.

## Tasks

1. Add bus scope concept:
   - main lead bus
   - lead-owned sub-bus
2. Attach spawned workers/Sr. agents to a sub-bus from `SPAWN_DECISION`.
3. Enforce policy:
   - workers cannot message main bus by default
   - workers report to owning lead/Sr.
   - lead summarizes to main bus
4. Trace sub-bus messages separately.
5. Dashboard distinguishes main bus vs sub-bus.
6. Validator checks sub-bus scope and summary inclusion.

## Acceptance criteria

- Worker messages are isolated to sub-bus.
- Main bus remains lead-only by default.
- Lead summary references worker evidence.
- Policy violations fail strict mode.

## Verification

- bus routing tests
- policy violation tests
- validator tests

## Exit gate

Worker communication can scale without making the main bus noisy.

---

# Phase 9 — Authority-weighted conflict resolution

## Primary issue

- #337

## Dependencies

- Phase 7 A2A primitives
- Phase 3 validator
- Phase 5 web steer authority for full participant map

## Purpose

Resolve peer challenge conflicts deterministically.

## Tasks

1. Add authority config to chains/teams.
2. Support global and optional domain-specific authority.
3. Attach authority metadata to claims/challenges.
4. Implement conflict policy:
   - preserve high-authority P0/P1 blockers by default
   - downgrade requires evidence, equal/higher authority, validator acceptance
5. Allow web/CLI steer authority adjustment with trace event.
6. Add validator checks for authority-based downgrades.

## Acceptance criteria

- Security/adversarial blockers cannot be casually downgraded.
- Lower-authority rebuttal without evidence does not override high-authority claim.
- Validator can reject unsupported authority decisions.
- Authority adjustments are trace-visible.

## Verification

- conflict resolver unit tests
- validator contradiction tests
- steer authority tests

## Exit gate

Lead peer communication has deterministic conflict semantics.

---

# Phase 10 — Optional peer challenge phase for swarm-review

## Primary issue

- #334

## Dependencies

- Phase 7 A2A primitives
- Phase 9 authority conflict resolution
- Phase 3 validator

## Purpose

Allow leads to challenge each other before final synthesis.

## Tasks

1. Add chain config for `peer_challenge`.
2. Define fixed challenge matrix for certification mode.
3. Add challenge result schema.
4. Enforce:
   - max rounds
   - max messages
   - timeout
   - response schema
5. Feed challenge results to synthesis.
6. Final contract records challenge status.
7. Validator checks challenge completion/unresolved blockers.

## Acceptance criteria

- Challenge phase can run once, bounded.
- Challenge phase can be explicitly skipped by config.
- Unresolved P0/P1 challenge blocks certification pass.
- Final synthesis includes challenge outcomes.

## Verification

- chain runner tests
- message bus/challenge tests
- validator tests
- echo swarm-review smoke

## Exit gate

Standard Swarm v2 can run bounded flat-lead peer review without uncontrolled chatter.

---

# Phase 11 — v2.1 comparative experiment and promotion decision

## Purpose

Validate whether v2.1 collaboration features should replace, augment, or remain separate from Standard Swarm v2 defaults. This phase only runs if the v2/v2.1 decision gate approves building Phases 7-10.

## Modes to compare

1. Current standard swarm: leads + default workers.
2. Lead-only swarm: five leads, no workers, no peer messaging.
3. Lead-first specialist mode: five leads, spawn workers only with decision contract.
4. Flat-lead mode: lead-first + bounded peer challenge.

## Metrics

- correctness of findings
- missed seeded issues
- false positives
- cost
- latency
- empty outputs
- scope drift
- lifecycle failures
- validator failures
- bus message count
- trace readability
- dashboard usefulness

## Acceptance criteria

- Standard Swarm v2 must improve or preserve finding quality while reducing cost/noise/failure surface.
- If it does not beat current mode, keep it opt-in.
- If it beats current mode, propose config migration and release gate changes.

## Verification

- repeated fixture runs
- live Pi controlled runs only after local/echo gates
- dashboard inspection
- validator evidence report

---

## Dependency graph

```text
Phase 1 lifecycle gates
  └── Phase 3 validator

Phase 2 participant presence
  ├── Phase 5 web steer participant
  ├── Phase 6 dashboard pool
  └── Phase 7 A2A primitives

Phase 3 validator foundation

Phase 4 spawn decisions
  ├── Phase 3/validator expands to validate spawn decisions
  └── Phase 8 scoped sub-buses

Decision gate after Phase 6
  └── Phases 7-10 only if v2.1 evidence is sufficient

Phase 7 A2A primitives
  ├── Phase 8 scoped sub-buses
  ├── Phase 9 authority conflict resolution
  └── Phase 10 peer challenge

Phase 3 validator
  ├── Phase 9 authority conflict resolution
  └── Phase 10 peer challenge

Phase 10 peer challenge
  └── Phase 11 comparative experiment
```

## Recommended grouping into PRs

### PR 1 — Certification lifecycle gates

Issues: #330

Small, high-value, production-critical.

### PR 2 — Participant presence trace state

Issues: #331

Foundation for dashboard, stale gates, and possible future A2A.

### PR 3 — Validator/verifier

Issues: #335 plus parts of #330

Evidence-first validation before more orchestration complexity.

### PR 4 — Structured worker spawn decisions

Issues: #340

Moves v2 toward lead-first/specialist-on-demand and reduces current cost/noise without A2A.

### PR 5 — Web steer participant

Issues: #338

Make human/operator control auditable.

### PR 6 — Dashboard agent pool

Issues: #332

Depends on participant state; may partially overlap PR 5.

### Decision gate — decide whether v2.1 exists

Required before any A2A/sub-bus/authority/peer-challenge PR. If the v2 foundation solves the observed problems, stop here and keep Phases 7-10 deferred.

### PR 7 — Session-local A2A primitives

Issues: #333

v2.1 only. Do after observability/validator/spawn-decision basics and after the decision gate approves v2.1.

### PR 8 — Scoped sub-buses

Issues: #339

v2.1 only. Build on A2A + spawn decisions.

### PR 9 — Authority conflict resolution

Issues: #337

v2.1 only. Build on A2A + validator + web steer authority.

### PR 10 — Peer challenge phase

Issues: #334

v2.1 only. Last orchestration feature; requires all guardrails.

### PR 11 — v2.1 comparative experiment and default decision

No single issue yet; can be created only if the v2/v2.1 decision gate approves Phases 7-10.

## Workflow validation: can this run to completion in a future goal session?

Yes for v2 Phases 1-6, if executed as staged PRs rather than one giant implementation. Phases 7-10 are not part of the default v2 goal session; they require a separate v2.1 RFC and decision.

### Why it is completable

- Each phase has a narrow output and explicit acceptance criteria.
- High-risk A2A/peer challenge work is delayed until trace/validator/dashboard foundations exist and a decision gate proves it is needed.
- Certification trust improves early in Phase 1, independent of later architectural work.
- The plan preserves current standard swarm while testing Standard Swarm v2 as opt-in.

### Main blockers to watch

- Dashboard persistence may not currently store enough event detail for participant snapshots.
- Current trace schema may need versioning or compatibility handling.
- Existing chain/team config may not support policy fields cleanly.
- Live Pi adapter may not expose enough heartbeat/current-tool events without adapter changes.
- Validator must avoid becoming an LLM opinion layer.

### Kill criteria / rollback points

- If participant presence makes traces too noisy, aggregate heartbeat snapshots instead of logging every tick.
- If A2A primitives introduce loops/cost blowups in tests, do not proceed to peer challenge.
- If lead-first mode misses seeded issues compared to current swarm, keep default workers for that chain.
- If dashboard pool becomes too complex, first ship backend evidence summaries and minimal UI.

## Definition of done for Standard Swarm v2

- Production certification is lifecycle/evidence-based.
- Dashboard shows live participant state.
- Web steer is a traceable high-authority participant.
- Validator independently checks final claims against evidence.
- Worker spawning is explicit and constrained.
- Standard Swarm v2 has been compared against current standard swarm with evidence.
- Default promotion decision is made based on measured quality/cost/reliability.

## Definition of done for possible v2.1

- The post-v2 decision gate found concrete lead-collaboration failures that v2 did not solve.
- Session-local A2A is bounded and policy-controlled.
- Scoped sub-buses isolate worker communication from the main lead bus.
- Authority-weighted conflict resolution is deterministic and validator-checked.
- Optional peer challenge phase is traceable, bounded, and validator-checked.
- v2.1 has been compared against v2 with evidence before any default promotion.

## Future work explicitly deferred

- Cross-device HTTP/SSE participant hub.
- Persistent expert nodes across sessions.
- Production/dev PII-redaction workflows.
- Networked remote machine agents.
- Fully autonomous multi-session workflow ledger.
