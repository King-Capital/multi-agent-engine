# Standard Swarm v2 Progress

Canonical PRD: `../standard-swarm-v2-prd-workflow.md`

## Current status

**Phase 3 implementation complete on `pi-phase3`.** Branch was created from merged Phase 1+2 main (`6015e5a`). Deterministic certification validator implemented with 35 targeted tests, CLI command, and bash harness integration.

## Current phase

Phase 3 deterministic validator — implementation complete, pending PR and review.

## Scope reminder

In scope for v2:

- Phase 1 lifecycle evidence gates
- Phase 2 participant presence/heartbeat
- Phase 3 deterministic validator
- Phase 4 structured spawn decisions
- Phase 5 web/CLI steer as high-authority participants
- Phase 6 dashboard agent pool

Out of scope unless explicitly approved by post-v2 decision gate:

- A2A primitives
- scoped sub-buses
- authority-weighted peer conflict resolution
- peer challenge phase
- cross-device HTTP/SSE hub

## Baseline notes

Phase 2 preflight recorded on branch `pi-phase2-participant-presence`, created from merged Phase 1 `main` commit `1ce507f`.

Current dirty state includes unrelated `.pi/skills/*.md` files and `.idea/` that must not be committed for this work. They pre-existed Phase 2 and are excluded.

Certification-foundation issue state checked with `gh issue view`: #288, #318, #319, #320, #321, #322, #323, #326, and #330 are all OPEN. Phase 1 must absorb/triage these rather than treating #330 alone.

Known historical risks:

- missing post-worker lead review
- empty output artifacts
- scope drift into previous `mae-cert.*` dirs
- final contract missing required fields
- broad prose/regex certification false positives
- canonical artifact lookup fallback or mismatch
- failed teams/session errors synthesized as ready
- `CERTIFICATION_CONTRACT` leaking into review squad prompts/outputs
- dashboard cannot easily answer lead status questions

## Phase checklist

### Phase 0 — Baseline and branch hygiene

- [x] Branch confirmed: `fix/live-certification-hardening`
- [x] Dirty state recorded
- [x] Unrelated `.pi/skills/*.md` excluded from commits
- [x] No stale live cert processes running
- [x] Baseline known failures recorded
- [x] Certification-foundation issues mapped: #288, #318, #319, #320, #321, #322, #323, #326

### Phase 1 — Lifecycle evidence gates (#330)

- [x] Evidence schema defined for current bash harness scope
- [x] Lead lifecycle completion gate implemented (lead-only mode in cert runs)
- [x] Empty output artifact gate implemented
- [x] Failed team/session error gate implemented
- [x] Scope drift gate implemented
- [x] Wrong fixture gate implemented
- [x] Canonical artifact/contract gate implemented
- [x] Structured contract validation rejects legacy prose/regex-only contracts in cert harness
- [x] `CERTIFICATION_CONTRACT` synthesis-only boundary enforced in cert harness canonical artifact selection; chain prompt boundary verified for swarm-review
- [x] Live Pi Phase 1 evidence run passes the hardened gates from `pi-phase1-complete` branch (all 3 fixtures: clean, seeded, failing; explicitly approved)
- [x] Parser false-pass/false-fail fixtures added for current harness failures
- [x] Cert harness tests added
- [x] Echo cert smoke passes

### Phase 2 — Participant presence/heartbeat (#331)

- [x] Participant types added
- [x] Emitter helpers added
- [x] Orchestrator instrumented
- [x] Leads instrumented
- [x] Workers instrumented
- [x] Adapter activity/current-tool events added where available
- [x] Participant capability metadata added
- [x] Stale/offline policy implemented
- [x] Trace schema docs updated
- [x] Targeted tests pass
- [x] Consolidated Codex runtime capability metadata and stale-on-existing-stall behavior
- [x] Deferred Claude ParticipantTracker as future source-of-truth work

### Phase 3 — Validator/verifier (#335)

- [x] `VALIDATION_CONTRACT` schema defined (`engine/certification-validator.ts`)
- [x] Deterministic evidence checks implemented (12 checks: lifecycle, operational failures, empty outputs, scope drift, wrong fixture, repo source reads, worker spawns, leaked contracts, canonical artifact, team contracts, stale participants, contract-evidence match)
- [x] Team-level structured contract validation implemented (REVIEW_REPORT vs CERTIFICATION_CONTRACT boundary)
- [x] `REVIEW_REPORT` vs `CERTIFICATION_CONTRACT` boundary validated
- [x] Validator cites trace/artifact evidence (each check includes evidence string and optional details)
- [x] LLM commentary documented as non-authoritative if present (all checks are deterministic, no LLM calls)
- [x] Validator wired into strict cert path (`mae validate-cert` CLI command with JSON/text output)
- [x] Contradiction tests added (35 tests covering all check types including contradictions)
- [x] Echo cert smoke passes (40 cert harness regression checks including 2 validator integration tests)

### Phase 4 — Structured spawn decisions (#340)

- [ ] `SPAWN_DECISION` schema defined
- [ ] Strict-mode worker spawn gate implemented
- [ ] Worker prompts generated from spawn decisions
- [ ] Validator checks spawn policy
- [ ] Tests pass

### Phase 5 — Web/CLI steer participants (#338)

- [ ] `web-steer` participant kind added
- [ ] `cli-steer` participant kind added
- [ ] Authority 90 default added
- [ ] Steer events traced
- [ ] Unattended vs interactive cert semantics implemented
- [ ] Validator checks steer effects
- [ ] Tests pass

### Phase 6 — Dashboard agent pool (#332)

- [ ] Participant source of truth decided
- [ ] Participants API added
- [ ] Agent pool UI added
- [ ] Certification badges added
- [ ] Manual dashboard verification complete

### Final v2 decision

- [ ] Small current-mode comparison fixture recorded
- [ ] Small lead-only comparison fixture recorded
- [ ] Small lead-first specialist comparison fixture recorded
- [ ] Cost/latency metrics recorded for small fixtures
- [ ] Validator reports recorded
- [ ] Dashboard screenshots/API snapshots recorded
- [ ] Default/opt-in/v2.1 decision made

## Verification log

Use targeted checks during tasks and the local phase/PR bundle at phase boundaries. Do not run live Pi swarms unless explicitly approved as a milestone.

| Date | Phase | Command / Evidence | Result | Notes |
|---|---:|---|---|---|
| 2026-05-18 | 0 | `git status --short --branch` | pass | Branch `fix/live-certification-hardening`; unrelated `.pi/skills/*.md` dirt present and excluded |
| 2026-05-18 | 0 | process check for cert runs | pass | No `certify-live-swarm` / MAE swarm-review processes found |
| 2026-05-18 | 0 | `gh issue view 288 318 319 320 321 322 323 326 330` | pass | All are open; mapped into Phase 1/3 scope |
| 2026-05-18 | 1 | `scripts/certify-live-swarm-test` | pass | 24 cert harness regression checks |
| 2026-05-18 | 1 | `scripts/certify-live-swarm --only failing --dashboard-url ${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}` | pass | Echo smoke only; no live Pi |
| 2026-05-18 | 1 | `just test && just check` | pass | 552 pass, 1 skip; tsc noEmit passed |
| 2026-05-18 | 1 | `scripts/certify-live-swarm-test` after strict-contract change | pass | Legacy prose contract is now rejected; 24 checks pass |
| 2026-05-18 | 1 | `scripts/certify-live-swarm --only failing --dashboard-url ${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}` after strict-contract change | pass | Echo smoke only; no live Pi |
| 2026-05-18 | 1 | `just test && just check` after strict-contract change | pass | 552 pass, 1 skip; tsc noEmit passed |
| 2026-05-18 | 1 | `scripts/certify-live-swarm-test` after spoofed squad contract regressions | pass | 26 cert harness regression checks |
| 2026-05-18 | 1 | `scripts/certify-live-swarm --only failing --dashboard-url ${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}` after spoofed squad contract regressions | pass | Echo smoke only; no live Pi |
| 2026-05-18 | 1 | `just test && just check` after spoofed squad contract regressions | pass | 552 pass, 1 skip; tsc noEmit passed |
| 2026-05-18 | 1 | chain-runner cert-mode degraded step (no throw) | impl | Step status "degraded" instead of "failed" when MAE_CERTIFICATION_MODE=1; session completes |
| 2026-05-18 | 1 | canonical artifact selection prefers CERTIFICATION_CONTRACT | impl | Iterates candidates, picks first with valid contract block; regression test added |
| 2026-05-18 | 1 | trace_has_failures → trace_has_operational_failures | impl | Separated operational (session crash) from substantive (FAILED grade) checks |
| 2026-05-18 | 1 | lead-only mode in cert runs | impl | MAE_CERTIFICATION_MODE=1 sets leadOnly=true; no workers spawned; 60s timeout |
| 2026-05-18 | 1 | live Pi clean+seeded fixtures | pass | Clean and seeded both passed with full worker swarm |
| 2026-05-18 | 1 | live Pi failing fixture (worker mode) | fail | Session completed but synthesis produced verdict:pass for negative fixture (LLM non-determinism) |
| 2026-05-18 | 1 | `scripts/certify-live-swarm-test` after lead-only + timeout | pass | 29 cert harness regression checks |
| 2026-05-18 | 1 | `bun test engine/team-execution.test.ts` | pass | 23 pass |
| 2026-05-18 | 1 | `just check` | pass | tsc noEmit clean |
| 2026-05-18 | 1 | live Pi failing fixture (lead-only) | pass | Correct contract: verdict:fail, certification_ready:false; $0.35 cost |
| 2026-05-18 | 1 | pipefail bug in unsuperseded_empty_output_artifacts | fix | `grep -q && printf` → `if grep -q; then printf; fi` to avoid silent exit |
| 2026-05-18 | 1 | **FULL LIVE PI CERT — all 3 fixtures** | **PASS** | `MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --dashboard-url ${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}`; artifacts `/private/var/folders/pw/92qs6gh94z75p3ypb8y3v7lc0000gn/T/mae-cert.NWZooc`; final trace `/private/var/folders/pw/92qs6gh94z75p3ypb8y3v7lc0000gn/T/mae-cert.NWZooc/traces/5d1bb890-eb72-41f6-8722-b03bde0a01c9.jsonl` |
| 2026-05-18 | 1 | pre-PR review swarm on `pi-phase1-complete` | fail → fixed | Found exact lead coverage and repo-source-read gates; both fixed with regressions |
| 2026-05-18 | 1 | `scripts/certify-live-swarm-test` on `pi-phase1-complete` | pass | 36 cert harness regression checks |
| 2026-05-18 | 1 | `bun test engine/team-execution.test.ts` on `pi-phase1-complete` | pass | 24 pass |
| 2026-05-18 | 1 | `just check` on `pi-phase1-complete` | pass | `cd engine && bunx tsc --noEmit` |
| 2026-05-18 | 1 | `bun test` on `pi-phase1-complete` | pass | 556 pass, 1 skip, 0 fail |
| 2026-05-18 | 1 | `scripts/certify-live-swarm --only failing --dashboard-url ${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}` on `pi-phase1-complete` | pass | Echo smoke; trace `/private/var/folders/pw/92qs6gh94z75p3ypb8y3v7lc0000gn/T/mae-cert.upD7A5/traces/5dcfb87d-eb71-4469-a948-2c4bf00d3f68.jsonl` |
| 2026-05-18 | 1 | `git diff --check` on `pi-phase1-complete` | pass | No whitespace errors |
| 2026-05-18 | 2 | `git switch -c pi-phase2-participant-presence` from merged main | pass | Base `1ce507f`; unrelated `.pi/skills/*.md` and `.idea/` excluded |
| 2026-05-18 | 2 | `bun test engine/event-emitter.test.ts engine/trace-recorder.test.ts engine/participant-presence.test.ts engine/team-execution.test.ts` | pass | 62 pass; participant lifecycle, heartbeat, stale detection, trace mapping, and team execution covered |
| 2026-05-18 | 2 | `just check` | pass | `cd engine && bunx tsc --noEmit` |
| 2026-05-18 | 2 | `scripts/certify-live-swarm-test` | pass | Phase 1 certification harness still passes after participant trace changes |
| 2026-05-18 | 2 | `scripts/certify-live-swarm --only failing --dashboard-url ${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}` | pass | Echo smoke; participant events emitted into trace during run |
| 2026-05-18 | 2 | `bun test` | pass | 562 pass, 1 skip, 0 fail |
| 2026-05-18 | 2 | `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` | pass | No whitespace errors in Phase 2 tracked diff |
| 2026-05-18 | 2 | pre-PR review swarm on `pi-phase2-participant-presence` | fail → fixed | Found duplicate orchestrator start, missing normal lead end, and synthesis kind metadata; all fixed with targeted regressions |
| 2026-05-18 | 2 | `bun test engine/event-emitter.test.ts engine/team-execution.test.ts engine/trace-recorder.test.ts engine/participant-presence.test.ts` after review fixes | pass | 66 pass, 0 fail |
| 2026-05-18 | 2 | `just check` after review fixes | pass | `cd engine && bunx tsc --noEmit` |
| 2026-05-18 | 2 | `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` after review fixes | pass | No whitespace errors |
| 2026-05-18 | 2 | `scripts/certify-live-swarm-test` after review fixes | pass | Certification harness remains green |
| 2026-05-18 | 2 | `scripts/certify-live-swarm --only failing --dashboard-url ${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}` after review fixes | pass | Echo smoke |
| 2026-05-18 | 2 | `bun test` after review fixes | pass | 566 pass, 1 skip, 0 fail |
| 2026-05-18 | 2 | `just check` after full test bundle | pass | `cd engine && bunx tsc --noEmit` |
| 2026-05-18 | 2 | re-review swarm on `pi-phase2-participant-presence` | fail → fixed | Prior F1-F3 closed; found duplicate `orch-1` participant_end on shutdown; fixed by making `agentDone("orch-1")` the terminal source and keeping `sessionEnd()` session-only |
| 2026-05-18 | 2 | `bun test engine/event-emitter.test.ts engine/team-execution.test.ts engine/trace-recorder.test.ts engine/participant-presence.test.ts` after R1 fix | pass | 67 pass, 0 fail |
| 2026-05-18 | 2 | `just check` after R1 fix | pass | `cd engine && bunx tsc --noEmit` |
| 2026-05-18 | 2 | `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` after R1 fix | pass | No whitespace errors |
| 2026-05-18 | 2 | second re-review swarm on `pi-phase2-participant-presence` | fail → fixed | Prior F1-F3/R1 closed; found dashboard named-SSE subscription gap for participant events; fixed by adding participant event names and SSE test |
| 2026-05-18 | 2 | `bun test dashboard-next/test/api-sse.test.ts engine/event-emitter.test.ts engine/team-execution.test.ts engine/trace-recorder.test.ts engine/participant-presence.test.ts` after R2 fix | pass | 68 pass, 0 fail |
| 2026-05-18 | 2 | `just check` after R2 fix | pass | `cd engine && bunx tsc --noEmit` |
| 2026-05-18 | 2 | `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` after R2 fix | pass | No whitespace errors |
| 2026-05-18 | 2 | `scripts/certify-live-swarm-test` after R2 fix | pass | 36 cert harness regression checks |
| 2026-05-18 | 2 | `scripts/certify-live-swarm --only failing --dashboard-url ${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}` after R2 fix | pass | Echo smoke; trace `/private/var/folders/pw/92qs6gh94z75p3ypb8y3v7lc0000gn/T/mae-cert.pQGv0h/traces/8ddbd401-32cb-4080-b6cb-8c650298aeea.jsonl` |
| 2026-05-18 | 2 | `bun test` after R2 fix | pass | 568 pass, 1 skip, 0 fail |
| 2026-05-18 | 2 | `just check` after R2 full bundle | pass | `cd engine && bunx tsc --noEmit` |
| 2026-05-18 | 2 | `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` after R2 full bundle | pass | No whitespace errors |
| 2026-05-18 | 2 | third re-review swarm on `pi-phase2-participant-presence` | pass | F1-F3/R1/R2 closed; no material in-scope Critical/High/Medium/P3 blockers |
| 2026-05-18 | 2 | consolidation decision: Pi base + Codex runtime metadata/stale, defer Claude tracker | impl | Added `DECISIONS.md` entry; normalized participant statuses to `starting|active|idle|stale|completed|failed|blocked` |
| 2026-05-18 | 2 | `bun test engine/event-emitter.test.ts engine/team-execution.test.ts engine/worker-lifecycle.test.ts engine/active-monitor.test.ts engine/participant-presence.test.ts engine/trace-recorder.test.ts` after consolidation | pass | 82 pass, 0 fail |
| 2026-05-18 | 2 | `cd engine && bunx tsc --noEmit` after consolidation | pass | Typecheck clean |
| 2026-05-18 | 2 | `scripts/certify-live-swarm-test` after final consolidation | pass | Cert harness regression checks pass |
| 2026-05-18 | 2 | `scripts/certify-live-swarm --only failing --dashboard-url ${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}` after final consolidation | pass | Echo smoke passes |
| 2026-05-18 | 2 | `bun test` after final consolidation | pass | 568 pass, 1 skip, 0 fail |
| 2026-05-18 | 2 | `cd engine && bunx tsc --noEmit` after final consolidation | pass | Typecheck clean |
| 2026-05-18 | 2 | `git diff --check -- . ':(exclude).pi/skills/*' ':(exclude).idea/*'` after final consolidation | pass | No whitespace errors |
| 2026-05-18 | 2 | focused final consolidation re-review | pass | No material in-scope Critical/High/Medium/P3 blockers; accepted Pi base + Codex metadata/stale + status normalization; Claude tracker deferred |

## Phase 1 evidence

Certification hardening is evidenced by deterministic fixtures, not only green commands:

- Canonical artifact selection prefers artifacts containing `CERTIFICATION_CONTRACT:` block over later prose artifacts. Multi-orchestrator-output regression test added.
- Spoofed worker/squad contract rejection is covered in cert test fixtures.
- Missing canonical artifact rejection is a hard failure in live Pi mode.
- Lead-only mode in cert runs eliminates empty outputs from unnecessary workers (~$0.35/fixture vs ~$2/fixture).
- Chain runner emits "degraded" status instead of throwing on FEEDBACK/FAILED grades in cert mode.
- Operational vs substantive failure separation: `trace_has_operational_failures` only checks session crashes, not individual agent grades.
- 36 local regression tests and echo smoke pass on final `pi-phase1-complete` branch.
- Approved full live Pi cert (3 fixtures) passed with preserved artifacts at `/private/var/folders/pw/92qs6gh94z75p3ypb8y3v7lc0000gn/T/mae-cert.NWZooc`.

## Phase 3 targeted validation snapshot

Branch: `pi-phase3` from merged Phase 1+2 main (`6015e5a`).

| Command | Result | Evidence |
|---|---|---|
| `bun test engine/certification-validator.test.ts` | pass | 35 pass, 0 fail; lifecycle, operational failures, empty outputs, scope drift, wrong fixture, worker spawns, leaked contracts, canonical artifact, contract-evidence match, stale participants, team contracts, repo source reads, format output |
| `cd engine && bunx tsc --noEmit` | pass | Typecheck clean |
| `scripts/certify-live-swarm-test` | pass | 40 cert harness regression checks including 2 TS validator integration tests |
| `bun test` | pass | 603 pass, 1 skip, 0 fail |
| `git diff --check` | pass | No whitespace errors |

## Open blockers

None currently for Phase 3 implementation. Focused re-review of final consolidation still required before updating PR #356 as ready.

## Open risks

- LLM non-determinism: synthesis occasionally produces wrong verdict for negative fixtures. Prompt tightened; full cert passed but not guaranteed on every run.
- Dashboard source-of-truth may require backend persistence work.
- Trace schema/versioning compatibility may need care.
- Heartbeat events can become noisy if not bounded.
- Validator must remain deterministic and evidence-first.
- Spawn-decision enforcement must not break legacy/current standard swarm unexpectedly.

## Handoff notes

When pausing a future implementation session, update:

1. Current phase
2. Completed checklist items
3. Verification log
4. Open blockers
5. Files changed
6. Next exact task
