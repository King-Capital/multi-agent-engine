# Codex Review of Claude Phase 1 Work

Date: 2026-05-18
Reviewer: Codex
Reviewed agent: Claude
Scope: Standard Swarm v2 Phase 1 lifecycle evidence gates

## Verdict

Conditional accept as useful Phase 1 evidence and implementation input, but not the preferred consolidation base.

Claude found real live-certification blockers and fixed the right classes of issues: lead-only certification, operational-vs-substantive failure separation, degraded cert steps, canonical artifact selection, and the `set -euo pipefail` empty-output bug. Those decisions should be kept.

I would not merge Claude's main-repo dirty state directly. The work was done in the main repo while other agents were active, with an unused worktree left behind, and the handoff did not include enough absolute live artifact detail to independently re-check the claimed all-fixture pass without filesystem recovery.

## Reviewed Evidence

Claude reported work on branch `fix/live-certification-hardening`, directly in the main repo.

Reported changed files:

- `engine/chain-runner.ts`
- `engine/team-execution.ts`
- `scripts/certify-live-swarm`
- `scripts/certify-live-swarm-test`
- `.planning/standard-swarm-v2/PROGRESS.md`
- `.planning/standard-swarm-v2/DECISIONS.md`

Reported validation:

- 29 cert harness regression tests pass.
- 555 Bun tests pass.
- TypeScript typecheck clean.
- Echo cert smoke passes.
- Full live Pi certification for clean, seeded, and failing fixtures passes with artifacts at `mae-cert.XayLua`.

## What Claude Got Right

1. Lead-only certification mode is the correct direction. Full worker swarms on tiny certification fixtures create cost, latency, and empty-output noise that does not improve lifecycle proof.

2. Operational failures and substantive review failures need separate gates. A target can correctly fail certification without the harness treating that as an orchestrator/session crash.

3. Cert mode should allow degraded step outcomes so the chain can reach synthesis and emit the final certification contract.

4. Canonical artifact selection must prefer artifacts containing a strict `CERTIFICATION_CONTRACT:` / `END_CERTIFICATION_CONTRACT` block instead of blindly using the last orchestrator artifact.

5. The shell `pipefail` bug in empty-output artifact scanning is real. `grep -q ... && printf ...` can return non-zero in the success path when no empty-output marker exists.

## Findings / Risks

### P1: Main-repo edits should not be the merge source

Claude created `../claude-cert-hardening` but worked directly in the main repo. That violates the worktree discipline for this multi-agent run and increases conflict risk with Pi/Codex and unrelated `.pi/skills/*.md` dirt.

Recommendation: use a clean consolidation worktree, or use Pi's `../pi-phase1-standard-swarm-v2` worktree as the base after comparing diffs.

### P1: Claimed live pass needs recoverable artifact evidence

The all-fixture live pass is the strongest part of Claude's handoff, but the handoff only names `mae-cert.XayLua`; it does not include the absolute artifact path, trace file paths, or session IDs.

Recommendation: before final Phase 1 signoff, recover and record exact live evidence in `PROGRESS.md` or `VALIDATION.md`: artifact dir, session IDs, trace paths, canonical contract artifact paths, and final PASS lines.

### P1: Readiness parser must not false-match `Certification ready: false`

The current main-repo `scripts/certify-live-swarm` still has a broad readiness matcher around `marks_certification_ready()` that can treat prose-style readiness text as evidence. The exact failure mode I saw live was prose such as `Certification ready: false`; this must not count as ready.

Recommendation: add a regression for `Certification ready: false` and require exact `CERTIFICATION_READY` or strict contract fields for positive readiness.

### P2: Non-synthesis contract spoofing should be gated

Phase 1 should certify only the final synthesis contract. If a lead or non-synthesis artifact emits a `CERTIFICATION_CONTRACT:` block, that should be flagged as a boundary violation unless the harness can prove it is the canonical synthesis artifact.

Recommendation: add a fixture/test that fails when non-synthesis artifacts leak certification contracts.

### P2: 90-second timeout may be tight

Claude reports a successful all-fixture run at 90 seconds, which is good evidence. My live runs showed Pi synthesis latency variance, so 90 seconds should be treated as a target with evidence, not a universal truth.

Recommendation: keep `MAE_CERT_TIMEOUT` configurable and document the default plus the observed full-live run duration.

## Final Recommendation

Keep Claude's technical fixes and decisions, especially D-009 and D-010. Do not use Claude's main-repo working tree as the merge source without a clean diff review.

Preferred path: consolidate through Pi's worktree if it includes Claude's accepted fixes, then verify the full local bundle and one live Pi all-fixture run from that consolidated state.
