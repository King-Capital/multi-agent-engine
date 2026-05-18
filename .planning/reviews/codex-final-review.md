# Codex Final Review of Phase 1 Peer Assessments

Date: 2026-05-18
Reviewer: Codex
Scope: What we learned from `.planning/reviews/*`

## Bottom Line

The peer-review docs are useful. They show strong convergence on the Phase 1 design, but they also show that Phase 1 should not be called fully complete until one final consolidated branch has the accepted fixes from all agents and fresh live evidence from that exact state.

The best consolidation base appears to be:

```text
/Volumes/ThunderBolt/Development/ai-agents/platforms/pi-phase1-standard-swarm-v2
```

Pi's worktree is the preferred base because it has the strongest coherent implementation shape, and both Claude and Codex reviews point toward using it as the merge/consolidation branch.

## Confirmed Convergence

All three agents independently converged on the same core Phase 1 decisions:

- Cert runs should be lead-only.
- Failed or negative review outcomes are substantive evidence, not operational crashes.
- Cert mode should allow degraded steps so synthesis can still emit the final contract.
- The canonical artifact must be the synthesis artifact containing `CERTIFICATION_CONTRACT`.
- Empty output and lifecycle defects need explicit gates.
- The shell pattern `grep -q ... && printf ...` is unsafe under `set -euo pipefail` and should be rewritten with `if grep; then printf; fi`.

That convergence is strong signal that the Phase 1 architecture is correct.

## Best Contributions by Agent

### Pi

Pi has the strongest consolidation base.

Useful Pi contributions:

- Structural `lead_only: true` on `swarm-review`.
- Inline `CERTIFICATION_CONTRACT:` synthesis prompt template.
- Pi adapter output extraction improvements.
- Empty-output result normalization.
- Justfile targets for repeatable cert checks.
- Incorporation of Claude's useful fixes.

### Claude

Claude found real live-certification blockers and produced useful validation evidence.

Useful Claude contributions:

- Operational vs substantive failure split.
- Degraded cert steps.
- Canonical artifact selection fix.
- `set -euo pipefail` empty-output bug fix.
- 90-second timeout evidence.
- Reported full live Pi all-fixture pass.

Concern: Claude worked directly in the main repo while other agents were active, and the handoff did not include enough absolute artifact/session detail to independently re-check the reported all-fixture live pass without recovery work.

### Codex

Codex did not finish Phase 1 live certification, but found hardening gaps worth porting before final signoff.

Useful Codex contributions:

- Explicit `PreparedTeamStep.leadOnly` boolean instead of prompt-string control flow.
- Worker-spawn rejection gate for Phase 1 certification.
- Non-synthesis `CERTIFICATION_CONTRACT` leak gate.
- Parser regression for `Certification ready: false`.
- Lead prompt guard preventing leads from emitting certification contracts.
- Additional harness tests.

Concern: Codex's full live Pi all-fixture wrapper did not reach a clean final pass before being stopped, so Codex's branch is review/fix input, not the completion source.

## Remaining Risks

### P1: Final proof must come from one consolidated state

The reviews prove convergence, but the final proof still needs to be run from the final consolidation branch.

Required evidence:

- Artifact directory.
- Session IDs.
- Trace paths.
- Canonical contract artifact paths.
- Final PASS output.
- Confirmation that no worker agents spawned in Phase 1 certification.
- Confirmation that no non-synthesis artifact emitted `CERTIFICATION_CONTRACT`.

### P1: Parser false positives must be blocked

The final harness must reject prose or negative readiness statements such as:

- `Certification ready: false`
- `certification_ready: false`
- `not certification ready`

Positive readiness should come from exact markers or strict contract parsing, not broad prose matching.

### P1: Contract boundary must be enforced

Only the final synthesis artifact should emit the certification contract. Lead/team artifacts should emit review evidence, not `CERTIFICATION_CONTRACT` blocks.

### P1: Pipefail fix must be verified in the final branch

The empty-output artifact scan must use:

```bash
if grep -q 'ERROR: Empty output' "$trace_dir/$artifact_ref"; then
  printf '%s\n' "$artifact_ref"
fi
```

The old `grep -q ... && printf ...` form can fail in the normal success path.

### P2: Permanent lead-only swarm-review is a behavior change

Making `swarm-review` lead-only outside cert mode is likely correct, but docs and decisions should make it explicit. Heavy multi-worker review should belong to `standard-swarm`.

## Recommended Final Path

1. Use Pi's worktree as the consolidation base:

   ```text
   /Volumes/ThunderBolt/Development/ai-agents/platforms/pi-phase1-standard-swarm-v2
   ```

2. Port or confirm these Codex hardening items:

   - Explicit `PreparedTeamStep.leadOnly` boolean.
   - Worker-spawn rejection gate.
   - Non-synthesis contract leak gate.
   - `Certification ready: false` parser regression.
   - Lead prompt guard against emitting `CERTIFICATION_CONTRACT`.
   - Focused tests for adapter final text extraction if that adapter change is adopted.

3. Confirm Claude's accepted fixes are present:

   - Pipefail fix.
   - Degraded cert steps.
   - Operational/substantive failure separation.
   - 90-second timeout default or documented override.

4. Run local validation:

   ```bash
   scripts/certify-live-swarm-test
   scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
   just check
   bun test engine/team-execution.test.ts
   bun test
   git diff --check
   ```

5. Run one final live Pi all-fixture certification from the final branch and record the evidence in the planning docs.

## Final Assessment

Phase 1 design is converged and mostly implemented. It is not fully certified until the final consolidated branch includes the accepted Codex hardening, Claude's accepted fixes, Pi's structural implementation, and a fresh full live Pi all-fixture pass with durable evidence.
