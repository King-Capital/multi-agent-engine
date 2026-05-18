# Codex Proposal: MAE Cross-Agent Review Protocol

Date: 2026-05-18
Source: `.planning/reviews/*`
Purpose: Turn the Phase 1 peer-review lessons into a repeatable MAE protocol.

## Short Answer

The reviews should become a first-class MAE protocol for high-risk work:

1. Run multiple agents in isolated worktrees.
2. Require each agent to produce an evidence-complete handoff.
3. Cross-review every other agent's result.
4. Build a convergence matrix from those reviews.
5. Choose one consolidation base.
6. Port only accepted deltas.
7. Re-run validation from the final consolidated state.
8. Record durable evidence before calling the phase complete.

The key lesson is that the value was not "three agents agreed." The value was that each agent found a different class of defect:

- Claude found live-runtime bugs.
- Pi produced the strongest architecture/consolidation base.
- Codex found defensive harness gates and parser risks.

The protocol needs to preserve that complementarity while preventing branch chaos, vague handoffs, and duplicate synthesis docs.

## Protocol Name

`cross-agent-convergence-review`

Suggested MAE chain shape:

```yaml
cross-agent-convergence-review:
  description: Parallel implementation plus peer review, convergence synthesis, and final evidence gate.
  mode: high-risk
  phases:
    - plan_lock
    - isolated_agent_runs
    - handoff_gate
    - pairwise_cross_review
    - convergence_synthesis
    - consolidation
    - final_validation
    - evidence_archive
```

## When To Use

Use this protocol for work where a false "done" claim is expensive:

- release gates
- live certification harnesses
- security-sensitive changes
- adapter/runtime lifecycle changes
- migrations
- distributed or multi-process workflows
- changes where deterministic tests are necessary but not sufficient

Do not use it for routine one-file fixes. The overhead is only justified when independent blind spots matter.

## Required Inputs

Before agents start, MAE should create a protocol packet:

```text
.planning/<protocol-run>/
  README.md
  TASKS.md
  VALIDATION.md
  DECISIONS.md
  HANDOFF_TEMPLATE.md
  REVIEW_TEMPLATE.md
  CONVERGENCE_MATRIX.md
```

The packet must define:

- exact goal
- explicit non-goals
- phase completion criteria
- required validation commands
- live validation policy
- artifact retention policy
- worktree naming convention
- branch naming convention
- allowed files or ownership boundaries
- handoff requirements
- review requirements

## Worktree Rules

Every agent must work in an isolated worktree. The main checkout is read-only during the protocol.

Required naming:

```text
../<agent>-<short-goal>
```

Examples:

```text
../pi-phase1-standard-swarm-v2
../claude-phase1-standard-swarm-v2
../codex-phase1-standard-swarm-v2
```

For Codex specifically, user preference is:

```text
../codex-...
```

MAE should reject a run if:

- an agent edits the main checkout
- a worktree exists but is unused
- unrelated dirty files are included in the candidate diff
- branch/worktree names are missing from the handoff

## Agent Role Profiles

The Phase 1 reviews show a useful pattern. MAE should assign complementary review biases explicitly.

### Live Debugger

Primary job:

- run the live path
- catch runtime/script/process issues
- preserve exact artifact evidence

Bias:

- "What fails only when the real adapter runs?"

Phase 1 example:

- Claude found the `set -euo pipefail` bug through live execution.

### Architect / Consolidator

Primary job:

- keep the implementation coherent
- improve source-of-truth config and engine design
- produce the cleanest merge base

Bias:

- "Where should this behavior live permanently?"

Phase 1 example:

- Pi provided the best base: structural `lead_only`, synthesis prompt template, adapter refactor.

### Defensive Tester

Primary job:

- add negative gates and regressions
- ask how the system could false-pass
- enforce trust boundaries

Bias:

- "What if the intended invariant silently breaks?"

Phase 1 example:

- Codex added worker-spawn rejection, non-synthesis contract leak detection, and parser false-positive checks.

## Mandatory Handoff

Each agent must produce a handoff before review. Handoffs must be machine-checkable enough that another agent can reproduce the claim.

Required fields:

```markdown
# Agent Handoff

Agent:
Model/runtime:
Worktree:
Branch:
Commit status:
Dirty files:
Files changed:

Goal:
What changed:
What was intentionally not changed:

Validation run:
- command:
  result:
  evidence path:

Live evidence, if any:
- artifact dir:
- session IDs:
- trace paths:
- canonical artifact path:
- final PASS/FAIL line:
- timeout:
- cost:

Known gaps:
Recommended consolidation base:
```

MAE should fail the handoff gate if live claims omit artifact dir, session IDs, or trace paths.

## Pairwise Review

Every agent reviews every other candidate using the same template.

Required outputs:

```text
.planning/reviews/<reviewer>-review-<subject>.md
```

Review template:

```markdown
# <Reviewer> Review of <Subject>

## Verdict

Accept / conditional accept / reject / useful input only.

## What is correct

## What is risky

## Unique contributions worth porting

## Evidence gaps

## Merge recommendation

## Required follow-up before final validation
```

Reviews must lead with findings, not summaries. This prevents weak "looks good" reviews from hiding blockers.

## Convergence Matrix

After pairwise reviews, MAE should generate a convergence matrix.

The matrix is the primary synthesis artifact, not long prose.

Example shape:

| Decision / Fix | Claude | Pi | Codex | Status |
|---|---|---|---|---|
| Lead-only certification | yes | yes | yes | accepted |
| Degraded cert steps | yes | yes | yes | accepted |
| Pipefail fix | yes | ported | partial | must verify |
| Worker-spawn rejection | no | no | yes | port to base |
| Non-synthesis contract leak gate | no | no | yes | port to base |
| Full live all-fixture pass | yes, weak evidence path | no | no | rerun final |

Status values:

- `accepted`
- `port_to_base`
- `reject`
- `needs_evidence`
- `defer`

## Consolidation Rules

Only one branch becomes the consolidation base.

Base selection criteria:

1. Cleanest worktree discipline.
2. Most coherent architecture.
3. Best source-of-truth placement.
4. Fewest unrelated changes.
5. Strongest validation evidence.
6. Easiest diff to review.

Phase 1 conclusion:

```text
Base: Pi worktree
Port: Codex hardening gates
Confirm: Claude live/runtime fixes
```

Consolidation must not blindly merge branches. It should port explicit accepted deltas from the convergence matrix.

## Final Validation Gate

No protocol run is complete until validation passes from the final consolidated branch.

For Standard Swarm v2 Phase 1, the final gate should be:

```bash
scripts/certify-live-swarm-test
scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
just check
bun test engine/team-execution.test.ts
bun test
git diff --check
```

Then one approved full live run:

```bash
MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
```

Required final evidence:

- artifact directory
- session IDs
- trace paths
- canonical contract artifact paths
- final wrapper PASS output
- timeout used
- cost
- proof no workers spawned when lead-only is required
- proof no non-synthesis artifact emitted certification contracts

## Evidence Archive

After final validation, MAE should write:

```text
.planning/<protocol-run>/FINAL_EVIDENCE.md
```

Required content:

- final branch/worktree
- exact commands run
- exact pass/fail results
- artifact paths
- session IDs
- trace paths
- canonical artifact paths
- accepted decisions
- rejected/deferred deltas
- known residual risk

If the final live run is skipped, the document must say so plainly and Phase completion must be downgraded.

## Stop Conditions

The protocol should stop and ask for human direction when:

- no candidate has reproducible validation
- agents disagree on the base branch
- live evidence conflicts with deterministic tests
- consolidation requires destructive git operations
- required live validation needs approval
- main checkout has unrelated dirty changes that affect the merge
- any agent claims done without evidence matching the handoff template

## What This Would Have Prevented In Phase 1

This protocol would have prevented or reduced:

- Claude working in the main checkout while other agents used worktrees.
- Ambiguous full-live evidence with only `mae-cert.XayLua` named.
- Duplicate synthesis docs with overlapping content.
- Different definitions of "done" across agents.
- Stopping Codex without clearly capturing whether its unique gates should still be ported.
- Treating local deterministic tests and full live certification as interchangeable.

## What This Would Have Preserved

This protocol preserves the useful part of the experiment:

- independent implementation
- independent blind spots
- pairwise review
- convergence-based decisions
- final evidence from the consolidated state

The strongest lesson from `.planning/reviews/` is that parallel agents are not mainly valuable because they are faster. They are valuable because independent blind spots overlap less. MAE should make that an explicit protocol instead of relying on ad hoc coordination.

## Suggested MAE Implementation

Add a protocol runner that can be invoked as:

```bash
mae protocol cross-agent-convergence-review --packet .planning/standard-swarm-v2
```

Minimum viable implementation:

1. Create named worktrees.
2. Launch configured agents with the same packet and role bias.
3. Require each agent to write `HANDOFF.md`.
4. Launch pairwise review tasks.
5. Generate `CONVERGENCE_MATRIX.md`.
6. Require user approval for consolidation.
7. Run final validation commands.
8. Write `FINAL_EVIDENCE.md`.

This does not need to be fully autonomous at first. The first useful version can be a guided protocol with hard evidence gates and generated templates.

## Final Recommendation

Turn the review folder into a reusable MAE protocol named `cross-agent-convergence-review`.

For Standard Swarm v2 Phase 1 specifically:

1. Use Pi as the consolidation base.
2. Port Codex's defensive hardening gates.
3. Confirm Claude's live-runtime fixes.
4. Run final validation from the consolidated branch.
5. Record durable evidence before declaring Phase 1 complete.

