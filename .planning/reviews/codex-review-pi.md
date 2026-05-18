# Codex Review of Pi Phase 1 Work

Date: 2026-05-18
Reviewer: Codex
Reviewed agent: Pi
Scope: Standard Swarm v2 Phase 1 lifecycle evidence gates

## Verdict

Preferred consolidation base, pending the known shell pipefail fix and final live-evidence verification.

Pi's worktree is reported as:

- Branch: `pi-phase1-standard-swarm-v2`
- Worktree: `/Volumes/ThunderBolt/Development/ai-agents/platforms/pi-phase1-standard-swarm-v2`

Based on the available peer reviews, Pi's implementation is the stronger Phase 1 base because it makes lead-only swarm review a structural chain property, strengthens the synthesis prompt at the source, and fixes Pi adapter output selection instead of relying only on harness-side cleanup.

## Reviewed Evidence

I reviewed the existing peer-review files:

- `.planning/reviews/claude-review-pi-phase1-swarm-v2.md`
- `.planning/reviews/pi-review-claude-phase1.md`

Reported Pi changes include:

- `agents/teams/chains.yaml`
- `engine/chain-runner.ts`
- `engine/team-execution.ts`
- `engine/team-execution.test.ts`
- `engine/types.ts`
- `engine/adapters/pi.ts`
- `engine/adapters/echo.ts`
- `scripts/certify-live-swarm`
- `scripts/certify-live-swarm-test`
- `docs/commands.md`
- `docs/concepts.md`
- `justfile`
- `.planning/standard-swarm-v2/*`

Reported validation after incorporating Claude deltas:

- Cert harness regression tests pass, 29 checks.
- Echo certification smoke passes with 90-second timeout.
- TypeScript noEmit passes.

## What Pi Got Right

1. The synthesis prompt template is the strongest unique contribution. Putting the `CERTIFICATION_CONTRACT:` template and semantic consistency rules in `engine/team-execution.ts` attacks the non-determinism at the source.

2. `lead_only: true` on the swarm-review teams matches the Phase 1 design better than cert-mode-only behavior. Standard swarm can remain the heavy path; swarm-review should be lean and evidence-focused.

3. The Pi adapter reverse text-block search is the right adapter-level fix for assignment-echo artifacts. The final non-empty assistant text is a better artifact source than the first text block.

4. The `resultFromFinalText` refactor and empty-output grading make empty outputs explicit failed lifecycle evidence instead of ambiguous successful artifacts.

5. Adding justfile targets for cert tests and live cert improves repeatability.

6. Pi incorporated Claude's useful fixes instead of rejecting them: 90-second timeout, empty-output pipefail fix, degraded cert steps, and operational/substantive failure separation.

## Findings / Risks

### P1: Verify the pipefail fix is present in the final consolidation diff

Claude found a real bug in Pi's first version of `unsuperseded_empty_output_artifacts`: `grep -q ... && printf ...` can return non-zero under `set -euo pipefail` when no artifact contains empty output.

Pi's review says the fix was incorporated. Before merge, confirm the final worktree uses:

```bash
if grep -q 'ERROR: Empty output' "$trace_dir/$artifact_ref"; then
  printf '%s\n' "$artifact_ref"
fi
```

### P1: Full live Pi all-fixture proof is still required from the final consolidated state

Pi's recorded validation is strong locally, but the peer-review summary only reports an echo smoke plus typecheck and cert tests after incorporating Claude deltas. Claude reports the all-fixture live Pi pass.

Recommendation: run the all-fixture live cert once from Pi's final consolidated branch and record artifact dir, session IDs, trace paths, canonical artifact paths, and PASS output.

### P1: Readiness parser must reject false prose readiness

The main repo copy of `scripts/certify-live-swarm` currently has broad readiness detection. The final Pi worktree must include a regression proving these do not count as ready:

- `Certification ready: false`
- `not certification ready`
- prose mentioning readiness without exact contract readiness

### P1: Certification contract source boundary needs a hard gate

The final harness should prove that only the canonical synthesis artifact can provide the certification contract. Lead/team artifacts should emit review reports, not certification contracts.

Recommendation: add or confirm a regression where a non-synthesis artifact containing `CERTIFICATION_CONTRACT:` fails the harness.

### P2: Permanent lead-only swarm-review is a behavior change

This is probably the right design, but it changes `mae chain swarm-review` outside cert mode. The docs and decisions should say this explicitly so users know heavy review belongs in `standard-swarm`.

## Final Recommendation

Use Pi's `../pi-phase1-standard-swarm-v2` worktree as the consolidation base, with Claude's accepted fixes included.

Do not declare Phase 1 fully complete until the final consolidated branch has:

1. Pipefail fix verified in `scripts/certify-live-swarm`.
2. False readiness parser regression.
3. Non-synthesis contract leak regression.
4. Full live Pi all-fixture run from the final branch with durable artifact/session evidence recorded.
