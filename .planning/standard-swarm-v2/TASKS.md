# Standard Swarm v2 Tasks

Canonical PRD: `../standard-swarm-v2-prd-workflow.md`

## Execution rule

This task list covers **v2 Phases 1-6 only**. Do not implement A2A, scoped sub-buses, authority-weighted peer conflict resolution, or peer challenge in this goal session. Those are v2.1/RFC items gated by post-v2 evidence.

## Phase 0 — Baseline and branch hygiene

### Task 0.1 — Confirm branch and dirty state

Issue: supports all

Objective:

Establish a clean execution context before implementation.

Likely commands:

- `git status --short --branch`
- inspect untracked/modified files

Acceptance criteria:

- Branch is identified.
- Unrelated `.pi/skills/*.md` dirt is explicitly excluded from commits.
- Existing live certification changes are understood.
- No stale live cert processes are running.

Verification:

- Git status captured in progress log.
- Process check captured if live runs were recently active.

Done means:

Future implementer knows exactly what files are in scope and what must not be committed.

---

### Task 0.2 — Record baseline failures and current cert behavior

Issue: #330, related #318-#323, #326

Objective:

Document known failure modes before modifying gates.

Known examples:

- missing post-worker lead review
- `ERROR: Empty output`
- scope drift to previous `mae-cert.*` directories
- final contract missing required fields

Acceptance criteria:

- Baseline notes are added to `PROGRESS.md`.
- Any preserved trace/run dirs needed for fixtures are recorded.

Verification:

- `PROGRESS.md` updated.

---

### Task 0.3 — Map certification-foundation issue prerequisites

Issue: #288, #318, #319, #320, #321, #322, #323, #326

Objective:

Prevent Phase 1 from rediscovering older open certification blockers mid-implementation.

Required mapping:

- #288 mechanically enforced orchestration contracts
- #318 production certification contract definition
- #319 strict machine-readable final swarm output
- #320 canonical final artifact lookup
- #321 structured contract validation instead of regex-only verification
- #322 failed teams/session errors fail certification
- #323 parser/harness false-pass and false-fail tests
- #326 `CERTIFICATION_CONTRACT` is synthesis-only; squads emit `REVIEW_REPORT`

Acceptance criteria:

- Each issue is recorded in `PROGRESS.md` as resolved, Phase 1 prerequisite, Phase 3 prerequisite, or explicitly deferred with reason.
- Phase 1 scope includes any still-open P0/P1 certification foundation issue that blocks trusted lifecycle evidence.
- No issue is silently ignored because a newer PRD phase appears to cover similar symptoms.

Verification:

- `gh issue view` notes or issue status summary captured in `PROGRESS.md`.

---

# Phase 1 — Lifecycle evidence gates

Primary issues: #330 plus certification foundation #318, #319, #320, #321, #322, #323, #326 as applicable

## Task 1.1 — Define lifecycle evidence schema

Objective:

Define the cert evidence object used by bash/TS validators.

Must include:

- expected teams
- delegated teams
- lead lifecycle completion
- worker spawn/review status per active mode
- empty output count
- failed agent/session count
- stale/offline count when available
- scope drift count
- wrong fixture access count
- canonical artifact path
- final contract validation result
- steer event counts when available
- failed teams/session error count
- synthesis-only certification contract source

Likely files:

- `scripts/certify-live-swarm`
- future: `engine/certification-evidence.ts`
- docs/tests in cert harness

Acceptance criteria:

- Evidence fields are documented in code comments or test fixtures.
- Lead-first mode and worker mode are both representable.
- Issue mapping from Task 0.3 is reflected in the schema where relevant.

Verification:

- `scripts/certify-live-swarm-test`

---

## Task 1.2 — Add missing lead lifecycle gate

Objective:

Fail certification if any required lead does not complete configured lifecycle.

Mode semantics:

- current worker mode: lead spawned/reviewed required workers
- lead-first mode: lead completed direct review and emitted valid `need_worker: false`, or spawned/reviewed justified workers

Acceptance criteria:

- Missing Security lead lifecycle fails.
- Missing Adversarial lead lifecycle fails.
- All required leads are checked by configured role/team, not fragile string-only assumptions where avoidable.

Verification:

- fixture test for missing lead lifecycle
- `scripts/certify-live-swarm-test`

---

## Task 1.3 — Add empty output artifact gate

Objective:

Fail live certification if any participant artifact contains `ERROR: Empty output`.

Acceptance criteria:

- Empty worker artifact fails.
- Empty orchestrator/synthesis artifact fails.
- Error reports include offending artifact path(s).

Verification:

- fixture test
- `scripts/certify-live-swarm-test`

---

## Task 1.4 — Add scope drift and wrong fixture gates

Objective:

Fail when tool calls inspect outside the current certification fixture scope.

Acceptance criteria:

- Tool calls to previous `mae-cert.*` directories fail.
- Tool calls to sibling fixtures fail for fixture-specific runs.
- Error output includes count and trace path.

Verification:

- fixture tests for previous temp dir and sibling fixture reads
- echo failing-only cert still passes

---

## Task 1.5 — Canonical artifact and contract consistency gate

Objective:

Ensure the cert harness validates canonical synthesis artifact and required contract fields.

Acceptance criteria:

- Missing canonical artifact fails live Pi certification.
- Missing `certification_ready` fails.
- Missing or malformed machine-readable certification contract fails.
- Broad prose/regex matches do not decide production certification.
- Contradictory ready/pass fields fail according to active expected fixture.

Verification:

- fixture tests
- echo cert smoke

---

## Task 1.6 — Enforce certification prompt/output boundaries

Issue: #326

Objective:

Avoid prompt/output conflicts where review squads emit final certification contracts or synthesis consumes squad-level spoofed contracts.

Mode semantics:

- Review squads emit `REVIEW_REPORT` blocks only.
- Final synthesis emits the canonical `CERTIFICATION_CONTRACT`.
- Harness prompts do not ask individual squads to emit `CERTIFICATION_CONTRACT`.

Acceptance criteria:

- Squad-level `CERTIFICATION_CONTRACT` output cannot satisfy final certification.
- Missing squad `REVIEW_REPORT` fails when required.
- Echo cert confirms synthesis still emits the canonical contract.

Verification:

- parser/harness fixture tests
- `scripts/certify-live-swarm-test`

---

## Task 1.7 — Add failed team/session and parser false-pass fixtures

Issue: #322, #323

Objective:

Make known certification parser and harness failures permanent regressions.

Acceptance criteria:

- Failed team/session events fail certification.
- 4-of-5 swarm coverage fails certification.
- Prompt echo false positives fail.
- Negated readiness wording fails.
- Missing artifact fallback fails.
- Seeded evidence and clean fixtures still parse deterministically.

Verification:

- certification parser/harness fixture tests
- `scripts/certify-live-swarm-test`

---

# Phase 2 — Participant presence and heartbeat

Primary issue: #331

## Task 2.1 — Add participant/presence types

Objective:

Define common participant state for orchestrator, leads, workers, synthesis, validator, web/CLI steer, and system actors.

Likely files:

- `engine/types.ts`
- `specs/trace-schema.md`

Acceptance criteria:

- Types support status, current task/tool, team/role/model, heartbeat, last event, cost/tokens.
- Existing agent events can map to participant IDs.

Verification:

- typecheck/build
- targeted type tests if present

---

## Task 2.2 — Add participant event emitter helpers

Objective:

Emit standardized participant lifecycle events.

Events:

- `participant.start`
- `participant.activity`
- `participant.heartbeat`
- `participant.stale`
- `participant.end`

Likely files:

- `engine/event-emitter.ts`
- `engine/trace-recorder.ts`

Acceptance criteria:

- Events are trace-recorded.
- Event schema is stable and documented.
- Heartbeat volume is bounded.

Verification:

- event emitter tests
- trace recorder tests

---

## Task 2.3 — Instrument orchestrator, leads, and workers

Objective:

Emit participant events from real execution paths.

Likely files:

- `engine/team-execution.ts`
- `engine/worker-lifecycle.ts`
- `engine/chain-runner.ts`
- adapters as needed

Acceptance criteria:

- Every lead/worker has start and terminal event.
- Long-running participants have heartbeat/activity updates.
- Adapter tool calls update current tool/activity where available.

Verification:

- targeted Bun tests
- inspect sample trace

---

## Task 2.4 — Add stale/offline detection policy

Objective:

Detect participants with no activity after configured thresholds.

Acceptance criteria:

- Stale state is emitted and trace-visible.
- Terminal events clear active/stale state.
- Certification can consume stale/offline evidence.

Verification:

- fake timer/unit tests if practical
- trace fixture test

---

## Task 2.5 — Add participant capability metadata

Objective:

Attach enough participant capability metadata for later policy checks without implementing v2.1 messaging.

Capabilities to represent:

- web/CLI steer control actions
- lead/worker communication permissions
- model/provider/tool capability hints where available

Acceptance criteria:

- Capability metadata is available in participant state or trace where practical.
- Web/CLI steer and lead/worker policies can consume the metadata in later phases.
- No A2A/sub-bus implementation is introduced by this task.

Verification:

- type/event tests
- trace fixture inspection

---

# Phase 3 — Deterministic validator/verifier

Primary issue: #335, related #318, #319, #321, #322, #323, #326

## Task 3.1 — Define `VALIDATION_CONTRACT`

Objective:

Create machine-readable validator output.

Fields:

- `schema_version`
- `validated`
- `evidence_complete`
- `lifecycle_valid`
- `contract_matches_evidence`
- `scope_valid`
- `steering_valid`
- `spawn_policy_valid`
- `blocking_reasons`

Acceptance criteria:

- Contract schema is documented.
- Missing/invalid validator contract fails strict mode.

Verification:

- validator schema tests

---

## Task 3.2 — Implement deterministic evidence validator

Objective:

Validate final certification claims against trace/artifact evidence.

Checks:

- lifecycle evidence complete
- no empty outputs
- no scope drift
- no stale/offline participants
- canonical artifact exists
- final contract matches lifecycle facts
- team-level structured contracts are present and schema-valid where required
- review squads emit `REVIEW_REPORT`; final synthesis emits `CERTIFICATION_CONTRACT`
- failed teams/session errors block certification

Acceptance criteria:

- Validator catches ready/pass claims with lifecycle failures.
- Validator cites evidence paths/events.
- LLM commentary, if any, is non-authoritative.
- Validator catches missing/invalid team contracts and certification prompt/output boundary violations.

Verification:

- unit tests for contradiction cases
- cert fixture tests

---

## Task 3.3 — Wire validator into certification path

Objective:

Make validator required for strict production certification.

Acceptance criteria:

- Strict cert fails on missing/failed validator.
- Echo smoke remains possible for cheap plumbing.
- Error output clearly distinguishes validator failure vs review failure.

Verification:

- `scripts/certify-live-swarm-test`
- echo cert smoke

---

# Phase 4 — Structured worker spawn decisions

Primary issue: #340

## Task 4.1 — Define `SPAWN_DECISION` schema

Objective:

Make worker spawning explicit and auditable.

Required fields:

- `need_worker`
- `spawn_type`
- `reason`
- `why_lead_cannot_do_it`
- constraints: allowed paths/tools, forbidden paths
- communication bus policy placeholder
- expected output schema
- timeout

Acceptance criteria:

- `need_worker: false` supported.
- Missing constraints fail in strict mode.

Verification:

- schema tests

---

## Task 4.2 — Require spawn decisions before worker creation in v2 strict mode

Objective:

Prevent unjustified/default worker spawning in Standard Swarm v2 strict mode.

Acceptance criteria:

- Worker creation without valid decision fails strict mode.
- Current standard swarm can still run in legacy/current mode.
- Spawn decisions are trace-visible.

Verification:

- worker lifecycle tests
- chain config tests

---

## Task 4.3 — Generate worker prompts from spawn decisions

Objective:

Improve worker prompt quality and reduce scope drift.

Acceptance criteria:

- Worker prompt includes exact scope, allowed tools, forbidden paths, output schema, and timeout.
- Prompt generation is deterministic from spawn decision.

Verification:

- snapshot/unit tests for generated prompts

---

## Task 4.4 — Validator checks spawn policy

Objective:

Ensure final validation catches unjustified/unconstrained worker spawning.

Acceptance criteria:

- Invalid spawn decision fails validator in strict mode.
- Worker main-bus access placeholder is rejected until v2.1 sub-bus policy exists.

Verification:

- validator tests

---

# Phase 5 — Web/CLI steer as high-authority participants

Primary issue: #338

## Task 5.1 — Add web/CLI steer participant kinds

Objective:

Represent dashboard and CLI control as participants.

Acceptance criteria:

- `web-steer` and `cli-steer` participant kinds exist.
- Default authority is 90.
- They appear in participant state when active.

Verification:

- type/event tests

---

## Task 5.2 — Trace steer messages/actions

Objective:

No dashboard/CLI control action should be invisible.

Trace fields:

- sender
- authority
- intent/action
- target
- reason
- certification impact

Acceptance criteria:

- Pause/resume/stop/steer actions create trace events.
- Authority adjustments are trace events.

Verification:

- backend API tests
- trace tests

---

## Task 5.3 — Add certification semantics for steer events

Objective:

Distinguish unattended and interactive certification.

Acceptance criteria:

- Unattended certification fails on web/CLI steer events.
- Interactive certification records steer count/effects.
- Validator checks steer did not hide lifecycle/evidence failures.

Verification:

- cert mode tests
- validator tests

---

# Phase 6 — Dashboard agent pool

Primary issue: #332

## Task 6.1 — Decide dashboard participant source of truth

Objective:

Avoid creating a second incompatible status model.

Investigate:

- live SSE/event reconstruction
- persisted history/aggregate queries
- trace JSONL availability

Acceptance criteria:

- Source-of-truth decision recorded in `DECISIONS.md`.
- API design follows that decision.

Verification:

- code inspection notes

---

## Task 6.2 — Add session participants API

Objective:

Expose participant snapshots to the dashboard.

Endpoint:

- `GET /api/sessions/:id/participants`

Acceptance criteria:

- Returns all known participants.
- Includes status, team/role, current task/tool, heartbeat age, cost/tokens if available.

Verification:

- backend tests

---

## Task 6.3 — Add dashboard agent pool UI

Objective:

Make live swarm state visible.

Columns:

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

Acceptance criteria:

- User can answer whether Security Lead is active/stale/reviewing/done.
- Missing lifecycle completion is visible.
- Web steer appears when present.

Verification:

- component tests if available
- manual visual check

---

## Task 6.4 — Add certification summary badges

Objective:

Show key cert evidence at a glance.

Badges:

- teams delegated
- lead lifecycles completed
- empty outputs
- stale participants
- scope drift
- steer events
- validator status

Acceptance criteria:

- Dashboard mirrors cert evidence status.
- Badge state links to evidence where practical.

Verification:

- manual dashboard check
- API snapshot

---

# Final v2 decision task

## Task 7.1 — Compare v2 against current standard swarm with small fixtures

Objective:

Decide whether Standard Swarm v2 should become default, remain opt-in, or trigger v2.1 RFC using small, practical comparison fixtures. Do not run full live swarms as routine validation.

Compare on small controlled targets:

1. current standard swarm behavior
2. lead-only behavior
3. lead-first specialist behavior

Metrics:

- finding quality on seeded fixture(s)
- missed seeded issues
- false positives
- cost
- latency
- empty outputs
- scope drift
- lifecycle failures
- validator failures
- trace readability
- dashboard usefulness

Acceptance criteria:

- Promotion decision is evidence-backed by small controlled runs.
- If v2.1 is needed, concrete failures are listed.
- If not needed, A2A/sub-bus/peer-challenge remain deferred.

Verification:

- small fixture traces
- validator reports
- dashboard snapshots/API snapshots
- cost/latency metrics
- no full live swarm unless explicitly approved as a final milestone
