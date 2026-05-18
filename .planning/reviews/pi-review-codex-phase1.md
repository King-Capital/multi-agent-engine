# Pi Review of Codex Phase 1 Work

Date: 2026-05-18
Reviewer: Pi
Reviewed agent: Codex
Scope: Standard Swarm v2 Phase 1 lifecycle evidence gates

## Reviewed source

Codex handoff reports work in:

- Worktree: `/Volumes/ThunderBolt/Development/ai-agents/platforms/codex-phase1-lead-only-cert`
- Branch: `fix/phase1-lead-only-cert`
- No commit made.

Codex explicitly called its result a **fail for Phase 1 full complete** because the full live Pi wrapper did not produce a clean final pass before it was stopped.

## Assessment summary

Overall assessment: **Strong implementation and debugging work, but not independently Phase-1-complete because full live Pi wrapper success is unresolved.**

Codex found several important hardening gaps that should be considered for the consolidated Phase 1 branch. However, because its full live Pi all-fixture run exited nonzero or was stopped before wrapper success, Codex's result should be treated as valuable review/fix input rather than the final source of truth.

## Positive findings worth keeping or comparing

### 1. Explicit `PreparedTeamStep.leadOnly` state

Codex implemented lead-only as explicit prepared-step state instead of checking prompt text to decide early return behavior.

Assessment: **Preferable design.**

Why:

- Avoids sentinel-string coupling (`LEAD-ONLY MODE`) in runtime control flow.
- Makes tests and future config behavior clearer.
- Reduces risk if prompt wording changes.

Recommendation:

Compare Codex’s implementation against Pi’s current `leadOpts.userPrompt.includes("LEAD-ONLY MODE:")` early-return check. Prefer adopting the explicit boolean if the diff is clean.

### 2. Non-synthesis `CERTIFICATION_CONTRACT` leak gate

Codex added a gate to reject `CERTIFICATION_CONTRACT` blocks emitted by non-synthesis participants.

Assessment: **Important hardening.**

Why:

- Directly addresses contract spoofing/confusion.
- Complements canonical artifact selection.
- Better than relying only on choosing the canonical artifact after the fact.

Recommendation:

Adopt or port this gate into the consolidation branch if not already present with equivalent coverage.

### 3. Worker-spawn rejection for Phase 1

Codex added a live gate that rejects worker spawns in Phase 1 certification mode.

Assessment: **Useful.**

Why:

- Phase 1 intent is lead lifecycle evidence only.
- This catches regressions where lead-only config is accidentally bypassed.

Caveat:

Codex already found an initial false positive: `team-execution` “Delegating to team” events with empty `agent_id` were counted as workers. The corrected gate must require a real non-lead `agent_id`.

### 4. Pi adapter last non-empty assistant text block

Codex changed Pi adapter output extraction to use the last non-empty assistant text block rather than the first text block.

Assessment: **Likely valuable, needs careful review.**

Why:

- Some agents may produce intermediate/streamed text before the final answer.
- The final assistant text is often the actual output artifact.

Risk:

- Could alter adapter behavior outside certification.
- Needs tests covering multi-text-block Pi RPC output.

Recommendation:

Review Codex’s adapter diff and tests before adopting. If adopted, add a focused adapter test.

### 5. Empty Pi output returns structured failure

Codex changed empty Pi output to `grade: FAILED` with `findings: ["empty_output"]`.

Assessment: **Good direction.**

Why:

- Empty output should be explicit and machine-readable.
- Supports Phase 1 empty artifact gate.

Risk:

- Must not create operational failure confusion. It should remain a substantive agent result unless the process itself failed.

### 6. Readiness parser false-positive fix

Codex found a parser false positive on `Certification ready: false`.

Assessment: **Important.**

Recommendation:

Ensure the consolidated harness has this exact regression covered. A parser that treats `false` as ready can false-pass negative fixtures.

## Concerns / issues with Codex work

### 1. Worktree naming convention violation

Codex worktree is named `codex-phase1-lead-only-cert`, not `pi-*`.

The user later clarified Pi-created worktrees must be `pi-*`; Codex may not have had that instruction at creation time, but consolidation should avoid introducing this pattern as precedent.

### 2. Branch name does not use `pi-*`

Branch is `fix/phase1-lead-only-cert`, not `pi-*`.

This is less critical for a Codex-owned worktree, but the consolidated Pi branch should remain `pi-phase1-standard-swarm-v2`.

### 3. Full live Pi wrapper did not pass

Codex correctly called this out as a blocker.

Full live Pi run artifact dir:

```text
/private/var/folders/pw/92qs6gh94z75p3ypb8y3v7lc0000gn/T/mae-cert.dbHevv
```

Sessions:

- clean: `afe508a0-5412-4f43-be5b-ea0f9b7bda5b`
- seeded: `1382ab92-6995-474a-9256-ff829e884090`
- failing: `702be52e-c4d5-41c1-809b-7aea9a414f48`

Codex was stopped before identifying the exact failing gate.

I inspected the artifact directory lightly. The per-fixture `.out` files show all three sessions completed, and no `CERTIFICATION FAILED` line was present in the preserved files I checked. This suggests the wrapper may have been stopped after session completion but before final wrapper status/logging, or failed in a gate whose message was not preserved where expected. This still needs exact reproduction/inspection before relying on Codex’s full-run evidence.

### 4. Timeout differs from Claude/Pi consolidation

Codex raised Pi timeout default to 150s. Claude reported full live all-fixture pass with 90s. Pi consolidation currently uses 90s.

Assessment:

- 150s may be safer but looser.
- 90s is supported by Claude’s reported full run and Pi’s single failing-fixture run.

Recommendation:

Keep 90s unless a repeatable timeout failure appears. If all-three-fixture full live runs intermittently exceed 90s, record evidence and revisit.

### 5. Full live rerun requires approval

The plan says live Pi runs are milestone checks requiring explicit approval. Codex’s suggested prompt says rerun full live only if needed/approved.

Recommendation:

Do not rerun full live from Codex worktree without explicit approval. Prefer reviewing preserved artifacts first.

## Validation reported by Codex

Passed:

- `scripts/certify-live-swarm-test` — 34 checks
- `bun test engine/team-execution.test.ts` — 24 pass
- Echo cert smoke — pass
- `just check` — pass
- Full `bun test` — 556 pass, 1 skip, 0 fail, 1414 expects
- Live Pi failing-only — pass

Not passed / unresolved:

- Full live Pi all-fixture wrapper did not reach clean wrapper success before stop.
- `git diff --check` should be rerun after final live fixes.

## Comparison to Pi consolidated worktree

Pi worktree:

```text
/Volumes/ThunderBolt/Development/ai-agents/platforms/pi-phase1-standard-swarm-v2
branch: pi-phase1-standard-swarm-v2
```

Pi currently has:

- Lead-only `swarm-review`.
- Harness canonical artifact selection.
- Empty output gates.
- Operational vs substantive failure split.
- Degraded cert steps.
- Echo smoke/typecheck/full tests passing.
- Approved live Pi failing-only pass.
- Claude’s pipefail fix and 90s timeout incorporated.

Potential Codex improvements still worth diffing/porting:

1. Explicit `PreparedTeamStep.leadOnly` state.
2. Non-synthesis `CERTIFICATION_CONTRACT` leak gate.
3. Worker-spawn rejection gate with real non-lead `agent_id` predicate.
4. Readiness parser false-positive regression for `certification_ready: false` / `Certification ready: false`.
5. Pi adapter last non-empty assistant text extraction, with tests.
6. Pi adapter empty output structured failure, with tests.

## Recommended next action

Before final Phase 1 consolidation, run a targeted diff review between Codex and Pi worktrees:

```bash
git -C /Volumes/ThunderBolt/Development/ai-agents/platforms/codex-phase1-lead-only-cert diff -- \
  engine/team-execution.ts \
  engine/adapters/pi.ts \
  scripts/certify-live-swarm \
  scripts/certify-live-swarm-test
```

Port the concrete hardening improvements above into `../pi-phase1-standard-swarm-v2`, then run:

```bash
scripts/certify-live-swarm-test
scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
just check
bun test engine/team-execution.test.ts
bun test
git diff --check
```

Only rerun full live Pi after explicit approval, or if the user decides Claude’s full-live pass plus Pi/Codex failing-only passes are sufficient for Phase 1 review.

## Final recommendation

Do not mark Codex’s branch as Phase 1 complete by itself. Treat it as a high-value review branch with several improvements to merge into the Pi consolidation branch. The final Phase 1 branch should be the Pi `pi-phase1-standard-swarm-v2` branch after incorporating any accepted Codex improvements and re-validating.
