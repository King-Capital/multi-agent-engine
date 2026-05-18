# Claude Review of Pi's Phase 1 Implementation

Branch: `pi-phase1-standard-swarm-v2`
Worktree: `/Volumes/ThunderBolt/Development/ai-agents/platforms/pi-phase1-standard-swarm-v2`
Reviewed: 2026-05-18

## Overall: GOOD — merge-ready with one bug fix

Pi and Claude independently converged on nearly identical solutions for every root cause. That convergence is strong signal the approach is correct.

## Convergence (identical decisions independently reached)

| Area | Match |
|------|-------|
| Chain-runner cert mode: skip retry loop | exact — `MAE_CERTIFICATION_MODE !== "1"` guard |
| Chain-runner cert mode: degraded step status | exact — `stepDegraded && !certMode ? "failed" : "degraded"` |
| Lead-only in cert mode via env var | exact — `step.lead_only === true \|\| process.env.MAE_CERTIFICATION_MODE === "1"` |
| `lead_only` added to `ChainStep` and `ParallelTeamStep` types | exact |
| Canonical artifact prefers `CERTIFICATION_CONTRACT:` block | exact — iterate candidates, prefer file with contract |
| Operational vs substantive failure separation | exact — `trace_has_operational_failures` checks session crashes only |
| Lead completion check replaces worker spawn/review count | exact — 5 leads required |
| Timeout via `MAE_CERT_TIMEOUT` env var | exact |

## Where Pi did better

### 1. Synthesis prompt template (strongest unique contribution)

Pi added an inline `CERTIFICATION_CONTRACT:` template with concrete field names, semantic consistency rules, and `failedTeams` detection directly in the `runParallelStep` synthesis prompt (`engine/team-execution.ts:988-1012`). This addresses the LLM non-determinism problem at the source — the model gets a structured template with explicit contract semantics instead of hoping the orchestrator produces the right format. Claude only tightened the failing fixture prompt in the harness, which is a downstream band-aid.

### 2. `lead_only: true` as permanent chain config

Pi set `lead_only: true` on all 5 swarm-review teams in `chains.yaml`. This makes swarm-review structurally lead-only for ALL runs, not just cert mode. Claude's approach only forces lead-only via the env var, meaning non-cert swarm-review runs would still spawn workers. Pi's approach matches the PRD design ("swarm-review is lean, standard-swarm is heavy").

### 3. Pi adapter `resultFromFinalText` refactor

Consolidated 3 duplicate result-building code blocks into one method. Empty output now correctly gets `grade: "FAILED"` and `findings: ["empty_output"]`. Clean DRY improvement.

### 4. Pi adapter reverse text block search

Changed `content.find(...)` to `[...content].reverse().find(...)` to get the last non-empty text block. This fixes the assignment-echo artifact problem at the adapter level — the right architectural location. Claude's approach relied on harness-level canonical artifact selection to work around this.

### 5. Incidental chain fixes

Added `read_only: true` to `red-blue` and `standard-swarm` chain teams that were missing it. Good hygiene.

### 6. Justfile targets

Added `cert-test` and `cert-live` targets. Better DX than remembering script paths.

### 7. Review docs

`reviews/` directory with multi-altitude review docs (100ft, 1000ft, 10000ft, up-close). Not code but useful context for future reviewers.

## Bug: pipefail in `unsuperseded_empty_output_artifacts`

Line 159 in Pi's `scripts/certify-live-swarm`:

```bash
grep -q 'ERROR: Empty output' "$trace_dir/$artifact_ref" && printf '%s\n' "$artifact_ref"
```

When `grep -q` finds no match (the success case — artifact is NOT empty), the `&&` short-circuits and the compound command returns exit code 1. With `set -euo pipefail`, this propagates through the `jq | while` pipeline and silently kills the script. Claude hit this exact bug during live testing and fixed it:

```bash
if grep -q 'ERROR: Empty output' "$trace_dir/$artifact_ref"; then
  printf '%s\n' "$artifact_ref"
fi
```

This bug will cause the harness to silently exit 1 on any run where artifacts exist but none contain empty output — which is the normal success path.

## Design choice: permanent lead-only swarm-review

Pi's `chains.yaml` makes swarm-review lead-only for ALL invocations, not just cert mode. This changes the behavior of `mae chain swarm-review "review this PR"` for regular (non-cert) use. Pi explicitly decided this (D-008) and the PRD supports it. Not a bug — just a behavioral change that affects all swarm-review users.

## Files reviewed

- `engine/chain-runner.ts` — cert mode changes
- `engine/team-execution.ts` — lead-only + synthesis prompt template
- `engine/team-execution.test.ts` — `buildParallelTeamStep` lead_only tests
- `engine/types.ts` — `lead_only` field additions
- `engine/adapters/pi.ts` — `resultFromFinalText` + reverse text block
- `engine/adapters/echo.ts` — CERTIFICATION_CONTRACT in echo output
- `agents/teams/chains.yaml` — lead_only on swarm-review, read_only on red-blue
- `scripts/certify-live-swarm` — full harness rewrite
- `scripts/certify-live-swarm-test` — 29 regression fixtures
- `docs/commands.md`, `docs/concepts.md` — lead-only documentation
- `justfile` — cert-test and cert-live targets
- `.planning/standard-swarm-v2/DECISIONS.md` — D-008
- `.planning/standard-swarm-v2/PROGRESS.md` — Phase 1 evidence
- `reviews/*` — multi-altitude review docs

## Recommendation

Merge Pi's branch as the base with the one pipefail bug fix applied. The synthesis prompt template and structural lead_only in chains.yaml are the two strongest differentiators over Claude's implementation.
