# Pi as GPT-5.5 — Synthesis of Phase 1 Peer Reviews

Date: 2026-05-18
Reviewer: Pi / GPT-5.5
Source directory: `/Volumes/ThunderBolt/Development/ai-agents/platforms/multi-agent-engine/.planning/reviews/`

## Reviewed files

- `claude-review-codex-phase1-swarm-v2.md`
- `claude-review-pi-phase1-swarm-v2.md`
- `codex-review-claude.md`
- `codex-review-pi.md`
- `pi-review-claude-phase1.md`
- `pi-review-codex-phase1.md`

## Executive summary

The three agents independently converged on the same Phase 1 architecture: certification runs must be lead-only, chain failures in cert mode should degrade rather than abort, operational failures must be separated from substantive negative findings, and canonical certification must come from the final synthesis artifact only.

The best consolidation base is still Pi’s `pi-phase1-standard-swarm-v2` worktree, but Codex contributed the strongest harness-hardening ideas and Claude contributed important live-debugging fixes. Phase 1 should not be considered final until the Codex hardening deltas are reviewed/ported and the final consolidated branch has clean validation evidence.

## High-confidence lessons

### 1. Lead-only certification is the right Phase 1 shape

All agents converged on lead-only cert runs.

Why it matters:

- Full worker swarms on tiny fixtures create cost, latency, empty outputs, and confusing lifecycle evidence.
- Phase 1 is about proving required lead lifecycle and certification gates, not maximal review breadth.
- Heavy worker coverage belongs in `standard-swarm`; lean certification review belongs in `swarm-review`.

Decision implication:

- Keep `swarm-review` structurally lead-only.
- Keep `standard-swarm` as full-squad/heavy mode.

### 2. Certification failure is not the same as orchestration failure

All agents identified the need to split:

- **Operational failures:** session crash, `agent.error`, `worker_failed`, missing artifact, timeout, scope drift.
- **Substantive failures:** a lead/synthesis correctly reports `FAILED`, `verdict: fail`, P0/P1 finding, or `certification_ready: false`.

Decision implication:

- Harness should fail on operational errors.
- Harness should allow substantive negative verdicts and validate them through the contract.

### 3. Cert mode must complete the chain so synthesis can emit the contract

Cert-mode `FEEDBACK`/`FAILED` grades should not throw before synthesis. They should be recorded as degraded/negative evidence, then the final contract decides certification readiness.

Decision implication:

- Keep degraded step status in cert mode.
- Normal non-cert chain failure semantics should remain unchanged.

### 4. Canonical artifact selection is a core trust boundary

All agents found that blindly picking the last orchestrator artifact can choose prose or stale output instead of the synthesis contract.

Decision implication:

- Prefer trace-linked synthesis/orchestrator artifacts that contain `CERTIFICATION_CONTRACT:` and `END_CERTIFICATION_CONTRACT`.
- In live Pi mode, no stdout fallback.
- Non-synthesis contracts should be rejected or at least unable to satisfy certification.

### 5. The shell harness is now critical infrastructure

The reviews surfaced multiple Bash hazards:

- `grep -q ... && printf ...` can return non-zero on the success path under `set -euo pipefail`.
- `if ! timeout ...; then exit_code=$?` captures the inverted `!` status, not the real timeout/process status.
- Broad readiness regexes can false-pass `Certification ready: false`.

Decision implication:

- Add regressions for every shell bug found.
- Prefer explicit `if grep; then ... fi` over `grep && ...` in functions used in pipelines.
- Capture command status without `!` when the raw exit code matters.

## Which agent contributed what

### Pi strengths

- Best consolidation base/worktree discipline after correction.
- Structural `lead_only: true` in `swarm-review`, not only env-driven cert behavior.
- Strong synthesis prompt with explicit `CERTIFICATION_CONTRACT` template.
- Pi adapter improvements: final text extraction / empty output as structured failure.
- Good docs/progress updates and review synthesis.

### Claude strengths

- Found and fixed real live-run blockers.
- Identified pipefail bug clearly.
- Provided successful full live Pi all-fixture evidence, reportedly at 90s timeout.
- Reinforced operational-vs-substantive failure split and degraded cert steps.

Claude weakness:

- Worked directly in the main repo while a worktree existed, creating consolidation risk.
- Handoff lacked full absolute trace/session evidence for the all-fixture pass.

### Codex strengths

Codex had the strongest harness/test hardening ideas:

- Worker-spawn rejection gate for Phase 1.
- Non-synthesis `CERTIFICATION_CONTRACT` leak gate.
- Explicit `PreparedTeamStep.leadOnly` boolean instead of prompt-string matching.
- Lead prompt instruction blocking review leads from emitting certification contracts.
- Better readiness parser regression for `Certification ready: false` / `certification_ready: false`.
- More harness tests: 34 vs Pi/Claude 29.

Codex weakness:

- Did not reach a clean full live Pi wrapper pass before being stopped.
- Timeout default of 150s may be looser than needed if Claude’s 90s all-fixture evidence is reliable.

## Concrete items to port/check before final Phase 1 signoff

From Codex into Pi consolidation, if not already present:

1. `PreparedTeamStep.leadOnly` typed state.
2. Worker-spawn rejection gate requiring a real non-lead `agent_id`.
3. Non-synthesis `CERTIFICATION_CONTRACT` leak gate.
4. Prompt guard: review leads must emit `REVIEW_REPORT`, not `CERTIFICATION_CONTRACT`.
5. Regression for `Certification ready: false` and `certification_ready: false` not counting as ready.
6. Adapter tests for last non-empty assistant text block, if the adapter change is retained.
7. `git diff --check` after final edits.

From Claude/Pi:

1. Keep 90s live timeout unless repeat evidence proves it too tight.
2. Keep pipefail fix.
3. Keep degraded cert steps.
4. Keep operational/substantive split.

## Current risk assessment

Phase 1 is close, but the review set says there are still hardening deltas worth porting before final signoff. The highest-risk missing gates are:

- Non-synthesis contract leak rejection.
- Worker-spawn rejection in Phase 1 cert traces.
- False readiness parser regression.
- Full live Pi all-fixture evidence recorded from the final consolidated branch with exact paths/session IDs.

## Recommended final path

1. Use Pi worktree as consolidation base:

```text
/Volumes/ThunderBolt/Development/ai-agents/platforms/pi-phase1-standard-swarm-v2
```

2. Diff Codex against Pi for:

```text
engine/team-execution.ts
engine/adapters/pi.ts
scripts/certify-live-swarm
scripts/certify-live-swarm-test
```

3. Port accepted Codex hardening deltas.

4. Run local validation:

```bash
scripts/certify-live-swarm-test
scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
just check
bun test engine/team-execution.test.ts
bun test
git diff --check
```

5. Only after explicit approval, run one full live Pi all-fixture certification from the final consolidated branch and record:

- artifact directory
- session IDs
- trace paths
- canonical artifact paths
- final wrapper PASS line
- total cost / timeout used

## Bottom line

We learned the architecture is right, but the harness needs to become stricter than the engine. Lead-only mode prevents noise; deterministic gates must prove no workers spawned, no non-synthesis contract leaked, no false readiness text passed, no scope drift occurred, and the final synthesis contract is canonical. Pi is the best base, Claude supplied key live fixes, and Codex supplied the strongest remaining hardening checklist.
