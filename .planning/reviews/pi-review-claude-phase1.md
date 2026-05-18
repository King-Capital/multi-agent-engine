# Pi Review of Claude Phase 1 Work

Date: 2026-05-18
Reviewer: Pi
Reviewed agent: Claude
Scope: Standard Swarm v2 Phase 1 lifecycle evidence gates

## Reviewed source

Claude handoff reported changes directly in the main repo on branch `fix/live-certification-hardening`, plus an unused clean worktree `../claude-cert-hardening`.

Primary files Claude reported changing:

- `engine/chain-runner.ts`
- `engine/team-execution.ts`
- `scripts/certify-live-swarm`
- `scripts/certify-live-swarm-test`
- `.planning/standard-swarm-v2/PROGRESS.md`
- `.planning/standard-swarm-v2/DECISIONS.md`

## Assessment summary

Claude found and fixed several real Phase 1 blockers. I accepted the material implementation ideas and incorporated the key deltas into the Pi worktree where appropriate.

Overall assessment: **Useful and mostly correct; needs branch/worktree hygiene correction before merge.**

## Findings from Claude worth keeping

### 1. Lead-only certification mode

Claude independently identified the same main root cause: certification runs should not spawn full worker sets for tiny fixture reviews.

Accepted.

Impact:

- Reduces cost and latency.
- Prevents empty-output failures from irrelevant workers.
- Makes lifecycle evidence focus on required leads.

### 2. Operational vs substantive failure split

Claude’s distinction is correct:

- Operational failures: session crash, `agent.error`, `worker_failed`, session end error.
- Substantive failures: review agents or synthesis correctly reporting `FAILED`/negative findings.

Accepted and documented as D-009.

### 3. Degraded cert steps

Claude’s `degraded` chain-step status in cert mode is correct. Certification runs need a complete trace and final contract even when the target should fail certification.

Accepted and documented as D-010.

### 4. Canonical artifact selection

Claude’s report that `tail -1` could pick the wrong `pi-orchestrator` artifact matches the observed issue class. Prefer canonical synthesis/orchestrator artifacts containing `CERTIFICATION_CONTRACT` and `END_CERTIFICATION_CONTRACT`.

Accepted.

### 5. Bash `pipefail` fix

Claude caught a real shell gotcha in `unsuperseded_empty_output_artifacts`: `grep -q ... && printf ...` can leak non-zero status through `set -euo pipefail` when grep finds no match.

Accepted and incorporated:

```bash
if grep -q 'ERROR: Empty output' "$trace_dir/$artifact_ref"; then
  printf '%s\n' "$artifact_ref"
fi
```

### 6. 90-second timeout

Claude reported full live Pi all-three-fixture evidence passed with a 90-second timeout. This is stronger than my single failing-fixture live run and tighter than my temporary 180-second timeout.

Accepted. Pi worktree now defaults to `MAE_CERT_TIMEOUT:-90` and docs reflect that.

## Concerns / issues with Claude work

### 1. Worktree rule violation

Claude worked directly in the main repo rather than using the created worktree.

Risk:

- Main repo already has unrelated `.pi/skills/*.md` dirt.
- Direct edits increase merge/conflict risk while Pi and Codex are running concurrently.

Recommendation:

- Before final merge, reconcile Claude’s main-repo edits through a proper worktree or use Pi’s `../pi-phase1-standard-swarm-v2` staged result as the consolidation point.

### 2. Unused worktree created

Claude created `../claude-cert-hardening` but did not use it.

Risk:

- Confusing state for later agents.
- Could be mistaken as the source of Claude’s changes.

Recommendation:

- Leave it untouched or remove it after confirming no changes exist.

### 3. Handoff evidence lacks exact trace path for all-fixture run

Claude reported full live Pi pass with artifacts at `mae-cert.XayLua`, but did not include the full absolute trace path or session IDs in the handoff.

Risk:

- Harder for later reviewers to verify the live evidence.

Recommendation:

- If possible, recover and record exact paths/session IDs in `PROGRESS.md` before final PR.

## Incorporated into Pi worktree

I incorporated these Claude deltas into `../pi-phase1-standard-swarm-v2`:

- `scripts/certify-live-swarm` timeout default set to 90s.
- `scripts/certify-live-swarm` empty-output artifact grep rewritten to `if grep; then printf; fi`.
- `.planning/standard-swarm-v2/DECISIONS.md` updated with D-009, D-010, D-011.
- `.planning/standard-swarm-v2/PROGRESS.md` updated for 90s timeout wording.
- `.planning/standard-swarm-v2/VALIDATION.md` updated for 90s timeout wording.

## Re-validation after incorporating Claude deltas

Run from Pi worktree `../pi-phase1-standard-swarm-v2`:

```bash
scripts/certify-live-swarm-test
scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
just check
```

Result:

- Cert harness regression tests: pass, 29 checks.
- Echo certification smoke: pass, timeout=90s.
- TypeScript noEmit: pass.

## Final recommendation

Use Pi’s `../pi-phase1-standard-swarm-v2` worktree as the consolidation branch for Phase 1, with Claude’s accepted fixes included. Do not merge Claude’s main-repo dirty state directly without comparing staged diffs and excluding unrelated `.pi/skills/*.md` files.
