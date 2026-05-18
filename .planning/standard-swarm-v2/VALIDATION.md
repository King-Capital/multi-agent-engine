# Standard Swarm v2 Validation Matrix

Canonical PRD: `../standard-swarm-v2-prd-workflow.md`

## Docs-as-source-of-truth validation rule

Before implementation and before phase completion, verify the docs still match the intended behavior:

- PRD and task docs should drive implementation decisions by default.
- Any deviation from the docs must be recorded in `DECISIONS.md`.
- If code inspection reveals the docs are wrong, update the docs before or alongside code changes.
- Do not rewrite working code paths without evidence and an explicit documented decision.

## Regression testing rule

Every observed certification/orchestration failure that reaches manual debugging must become a regression fixture/test before the fix is considered complete.

Regression candidates include:

- missing lead lifecycle
- missing worker review when required
- invalid direct lead completion
- empty output artifact
- failed agent/session event
- scope drift to previous `mae-cert.*`
- sibling fixture read
- repo-source read during fixture-only cert
- write attempt during read-only cert
- missing `certification_ready`
- `verdict: pass` with blockers
- failed teams but `certification_ready: true`
- canonical artifact mismatch
- hidden web/CLI steer
- worker spawned without valid decision

## Validation policy

Each phase requires:

1. targeted tests for changed logic
2. relevant integration/smoke tests
3. full project verification before phase completion
4. explicit evidence recorded in `PROGRESS.md`

Do not call a phase complete with known lint/typecheck/test/build failures.

## Practical verification policy

Use the smallest reliable checks while developing each task, then run the broader local suite at phase/PR boundaries. Do **not** run full live swarms as routine validation.

### Per-task targeted checks

Run the narrowest relevant tests for changed logic, for example:

```bash
bun test engine/<changed-module>.test.ts
scripts/certify-live-swarm-test
```

### Phase/PR local verification bundle

Run this bundle at the end of each implementation PR/phase unless impossible, and record the reason if any command is skipped.

```bash
scripts/certify-live-swarm-test
bun test
just check
```

### Small cert smoke

When dashboard is reachable, use the cheap echo cert smoke, not a live Pi swarm:

```bash
scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
```

### Dashboard/UI phases

Dashboard/UI phases should use focused backend/API/component/build checks discovered from the repo scripts. Add manual/browser verification only for visible UI changes.

### Live Pi policy

Live Pi validation is **not** required for every phase and should not be used as a normal dev feedback loop. It is reserved for explicit certification milestones after local/echo/full checks pass and after the user approves the run.

## Phase validation matrix

| Phase | Requirement | Issue | Targeted validation | Full validation | Status |
|---|---|---:|---|---|---|
| 0 | Certification-foundation issues triaged | #288/#318-#323/#326 | issue status summary | progress log | pending |
| 1 | Production certification contract defined | #318 | parser/schema fixture test | standard bundle | pending |
| 1 | Strict machine-readable final output required | #319 | synthesis contract fixture test | standard bundle | pending |
| 1 | Canonical artifact lookup has no live stdout fallback | #320 | missing-artifact fixture test | standard bundle + echo smoke | pending |
| 1 | Structured contract validation replaces regex-only decision | #321 | valid/malformed/partial contract tests | standard bundle | pending |
| 1 | Failed teams/session errors fail cert | #322 | failed-team/session fixture test | standard bundle | pending |
| 1 | Parser false-pass/false-fail cases covered | #323 | parser fixture suite | standard bundle | pending |
| 1 | Squad/final contract prompt boundary enforced | #326 | squad REVIEW_REPORT / synthesis CERTIFICATION_CONTRACT fixture | standard bundle + echo smoke | pending |
| 1 | Missing lead lifecycle fails cert | #330 | cert fixture test | standard bundle | pending |
| 1 | Empty output artifact fails cert | #330 | cert fixture test | standard bundle | pending |
| 1 | Scope drift fails cert | #330 | cert fixture test | standard bundle | pending |
| 1 | Wrong fixture access fails cert | #330 | cert fixture test | standard bundle | pending |
| 1 | Canonical contract validates | #330 | cert fixture test + echo smoke | standard bundle | pending |
| 2 | Participant start/end emitted | #331 | event/trace unit tests | standard bundle | pending |
| 2 | Heartbeat/activity bounded | #331 | event/trace unit tests | standard bundle | pending |
| 2 | Stale/offline detectable | #331 | fake timer/trace tests | standard bundle | pending |
| 2 | Participant capability metadata available | #331/#338/#340 | type/event tests | standard bundle | pending |
| 3 | Validator catches lifecycle contradiction | #335 | validator unit tests | standard bundle | pending |
| 3 | Validator catches scope drift | #335 | validator fixture tests | standard bundle | pending |
| 3 | Validator catches missing/invalid team structured contracts | #335/#321 | validator fixture tests | standard bundle | pending |
| 3 | Validator enforces REVIEW_REPORT vs CERTIFICATION_CONTRACT boundary | #335/#326 | validator/parser fixture tests | standard bundle | pending |
| 3 | Validator cites evidence paths/events | #335 | validator output tests | standard bundle | pending |
| 3 | Validator contract required in strict mode | #335 | cert integration test | standard bundle | pending |
| 4 | Spawn decision schema validates | #340 | schema/unit tests | standard bundle | pending |
| 4 | Worker spawn without decision fails strict mode | #340 | worker lifecycle tests | standard bundle | pending |
| 4 | Worker prompts derive from spawn decision | #340 | snapshot/unit tests | standard bundle | pending |
| 5 | Web/CLI steer participant traced | #338 | API/trace tests | standard bundle | pending |
| 5 | Unattended cert fails on steer event | #338 | cert mode tests | standard bundle | pending |
| 5 | Interactive cert records steer event | #338 | cert mode tests | standard bundle | pending |
| 6 | Participants API returns snapshots | #332 | backend API tests | standard bundle + dashboard build/tests | pending |
| 6 | Agent pool renders participant state | #332 | component/manual tests | standard bundle + dashboard build/tests | pending |
| 6 | Cert badges mirror evidence state | #332 | API/component/manual tests | standard bundle + dashboard build/tests | pending |

## Live Pi certification validation milestones

Live Pi runs are optional milestone checks, not routine validation. Run them only after local/echo/full checks pass and only with explicit user approval.

### Milestone A — after Phase 1

Purpose: prove hard lifecycle gates fail closed on live Pi invalid runs and pass echo fixtures.

Required:

```bash
scripts/certify-live-swarm-test
bun test
just check
scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
```

Optional live run, only if explicitly approved:

```bash
MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
```

### Milestone B — after Phase 3

Purpose: prove validator blocks final contract/evidence contradictions.

Required:

- standard full bundle
- validator fixture suite
- echo cert smoke

Optional live run, only if explicitly approved:

```bash
MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
```

### Milestone C — after Phase 6

Purpose: full v2 local/echo/dashboard readiness.

Required:

- standard full bundle
- dashboard backend tests/build
- dashboard-next tests/build/lint where available
- manual dashboard verification or browser-based verification
- echo cert smoke

Optional final live Pi certification, only if explicitly approved:

```bash
MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
```

## Final Phase 1 consolidation validation snapshot

Branch/worktree: `pi-phase1-complete` at `/Volumes/ThunderBolt/Development/ai-agents/platforms/pi-phase1-complete`.

Local/echo gates run from the final branch on 2026-05-18:

| Command | Result | Evidence |
|---|---|---|
| `scripts/certify-live-swarm-test` | pass | 36 cert harness regression checks |
| `bun test engine/team-execution.test.ts` | pass | 24 pass |
| `just check` | pass | `cd engine && bunx tsc --noEmit` |
| `bun test` | pass | 556 pass, 1 skip, 0 fail |
| `scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"` | pass | Echo smoke; trace `/private/var/folders/pw/92qs6gh94z75p3ypb8y3v7lc0000gn/T/mae-cert.upD7A5/traces/5dcfb87d-eb71-4469-a948-2c4bf00d3f68.jsonl` |
| `MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"` | pass | Approved full live Pi all-fixture run; artifacts `/private/var/folders/pw/92qs6gh94z75p3ypb8y3v7lc0000gn/T/mae-cert.NWZooc`; final trace `/private/var/folders/pw/92qs6gh94z75p3ypb8y3v7lc0000gn/T/mae-cert.NWZooc/traces/5d1bb890-eb72-41f6-8722-b03bde0a01c9.jsonl` |
| `git diff --check` | pass | No whitespace errors |

Full live Pi all-fixture certification was explicitly approved and passed before final regression-only harness tightening. The final branch then passed the 36-check harness, echo smoke, full test suite, and typecheck.

## Phase 2 targeted validation snapshot

Branch: `pi-phase2-participant-presence` from merged Phase 1 `main` (`1ce507f`).

Targeted checks run on 2026-05-18:

| Command | Result | Evidence |
|---|---|---|
| `bun test engine/event-emitter.test.ts engine/trace-recorder.test.ts engine/participant-presence.test.ts engine/team-execution.test.ts` | pass | 62 pass; participant lifecycle, heartbeat, stale detection, trace mapping, and team execution |
| `just check` | pass | `cd engine && bunx tsc --noEmit` |
| `scripts/certify-live-swarm-test` | pass | Phase 1 certification harness remains green |
| `scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"` | pass | Echo cert smoke with participant trace events |
| `bun test` | pass | 562 pass, 1 skip, 0 fail |
| `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` | pass | No whitespace errors in Phase 2 diff |

Pre-PR review swarm initially failed with three P3 lifecycle gaps. Fixes applied:

- F1: `sessionStart()` no longer emits a duplicate `orch-1` participant; `agentSpawn("orch-1")` is the canonical orchestrator participant start.
- F2: normal multi-worker team leads now emit `agentDone`/`participant_end` and are untracked after lead review/final result.
- F3: synthesis spawn passes an explicit `synthesis` participant kind override, producing `kind: "synthesis"` and `current_task: "agent:synthesis"`.

Post-fix targeted checks:

| Command | Result | Evidence |
|---|---|---|
| `bun test engine/event-emitter.test.ts engine/team-execution.test.ts engine/trace-recorder.test.ts engine/participant-presence.test.ts` | pass | 66 pass, 0 fail; regression coverage for all review findings |
| `just check` | pass | `cd engine && bunx tsc --noEmit` |
| `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` | pass | No whitespace errors |
| `scripts/certify-live-swarm-test` | pass | Certification harness remains green after review fixes |
| `scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"` | pass | Echo smoke after review fixes |
| `bun test` | pass | 566 pass, 1 skip, 0 fail |
| `just check` | pass | `cd engine && bunx tsc --noEmit` after full test bundle |

Re-review swarm closed F1-F3 and found one new P3:

- R1: normal shutdown emitted duplicate `participant_end` for `orch-1` via both `agentDone("orch-1")` and `sessionEnd()`.

R1 fix applied: `agentDone("orch-1")` is the canonical orchestrator participant terminal event; `sessionEnd()` updates/emits session status only and no longer emits a participant terminal event.

Post-R1 targeted checks:

| Command | Result | Evidence |
|---|---|---|
| `bun test engine/event-emitter.test.ts engine/team-execution.test.ts engine/trace-recorder.test.ts engine/participant-presence.test.ts` | pass | 67 pass, 0 fail; regression asserts one `orch-1` participant_end across agentDone + sessionEnd |
| `just check` | pass | `cd engine && bunx tsc --noEmit` |
| `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` | pass | No whitespace errors |

Second re-review swarm closed F1-F3/R1 and found one new P3:

- R2: React dashboard SSE client did not subscribe to named `participant_*` SSE event types.

R2 fix applied: participant event names are included in `SSE_EVENT_TYPES`, with a frontend API test proving a named `participant_heartbeat` frame reaches `subscribeToSession()` consumers.

Post-R2 targeted checks:

| Command | Result | Evidence |
|---|---|---|
| `bun test dashboard-next/test/api-sse.test.ts engine/event-emitter.test.ts engine/team-execution.test.ts engine/trace-recorder.test.ts engine/participant-presence.test.ts` | pass | 68 pass, 0 fail; includes named participant heartbeat SSE delivery |
| `just check` | pass | `cd engine && bunx tsc --noEmit` |
| `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` | pass | No whitespace errors |
| `scripts/certify-live-swarm-test` | pass | 36 cert harness regression checks |
| `scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"` | pass | Echo smoke; trace `/private/var/folders/pw/92qs6gh94z75p3ypb8y3v7lc0000gn/T/mae-cert.pQGv0h/traces/8ddbd401-32cb-4080-b6cb-8c650298aeea.jsonl` |
| `bun test` | pass | 568 pass, 1 skip, 0 fail |
| `just check` | pass | `cd engine && bunx tsc --noEmit` after full test bundle |

Third re-review swarm passed: F1-F3/R1/R2 closed with no material in-scope Critical/High/Medium/P3 blockers. Live Pi remains milestone-only and requires explicit approval.

## Evidence requirements for phase completion

For each phase, `PROGRESS.md` must record:

- commit hash if committed
- files changed
- targeted tests run and result
- full verification commands and result
- skipped checks with reason
- known blockers/risks
- whether live Pi was intentionally skipped or explicitly approved/run

## Failure handling

If any required validation fails:

1. do not call the phase complete
2. record failure in `PROGRESS.md`
3. add or update a regression fixture/test for the failure when practical
4. fix in-scope failures
5. rerun targeted tests
6. rerun full verification bundle
7. update docs/`DECISIONS.md` if behavior or scope changed
8. only then mark complete; do not run live Pi unless it is an approved milestone

## Final v2 acceptance

Standard Swarm v2 is not complete until:

- all Phase 1-6 rows are passing
- standard full verification bundle passes
- dashboard verification passes
- validator evidence reports are produced
- comparison runs are recorded or explicitly deferred with reason
- no known required lint/typecheck/test/build failures remain
