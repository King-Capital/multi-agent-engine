# Codex Full Protocol: Evidence-Driven Parallel Agent Review

Date: 2026-05-18
Author: Codex
Source directory: `.planning/reviews/full-review/`
Derived from: Standard Swarm v2 Phase 1 peer-review experiment

## Protocol Summary

This protocol converts the Phase 1 cross-agent experiment into a repeatable MAE workflow.

The core idea:

> Multiple agents are useful when their blind spots differ. The protocol must preserve independent implementation, force evidence-rich handoffs, cross-review the candidates, converge on one base, port only accepted deltas, and validate the final consolidated state.

This is not a "run three agents and pick your favorite" workflow. It is a controlled evidence pipeline.

## Protocol Name

`evidence-driven-parallel-review`

Short alias:

`edpr`

## Use This Protocol When

Use EDPR for high-risk work where one agent's "done" claim is not enough:

- release blockers
- certification harnesses
- security-sensitive changes
- adapter/runtime lifecycle work
- shell/process orchestration
- migrations
- concurrency-sensitive workflows
- changes where live behavior can diverge from deterministic tests

Do not use EDPR for simple fixes. The overhead is only worth it when independent blind spots can catch different defect classes.

## Non-Negotiable Principles

1. **One source packet.** Every agent starts from the same PRD/task/validation packet.
2. **One worktree per agent.** The main checkout is read-only.
3. **No inter-agent coordination during implementation.** Convergence is only meaningful if it is independent.
4. **Handoff before review.** No review starts until the subject agent has produced a structured handoff.
5. **Findings before praise.** Reviews lead with bugs, risks, evidence gaps, and port-worthy deltas.
6. **One synthesis.** Multiple synthesis docs create noise; the protocol produces one authoritative synthesis.
7. **One consolidation base.** Do not merge branches together blindly.
8. **Final validation must run from the final consolidated state.** Prior worktree evidence is useful input, not final proof.
9. **Live claims require durable evidence.** Artifact dir, sessions, traces, canonical artifacts, and final output are mandatory.
10. **Incomplete is a valid status.** Honest failure is more useful than vague success.

## Required Directory Layout

Each protocol run should create:

```text
.planning/<run-slug>/
  README.md
  TASKS.md
  VALIDATION.md
  DECISIONS.md
  AGENTS.md
  HANDOFF_TEMPLATE.md
  REVIEW_TEMPLATE.md
  CONVERGENCE_MATRIX.md
  CONSOLIDATION_PLAN.md
  FINAL_EVIDENCE.md

.planning/reviews/
  <reviewer>-review-<subject>.md
  <run-slug>-synthesis.md
```

For this Phase 1 run, the equivalent source was:

```text
.planning/standard-swarm-v2/
.planning/reviews/
```

## Phase 0: Contract Lock

Before any agent starts coding, the orchestrator locks the contract.

Required content:

- goal
- non-goals
- files in scope
- files explicitly out of scope
- branch/worktree naming convention
- commit policy
- validation commands
- live-run approval policy
- artifact retention policy
- phase completion criteria
- stop conditions

Example:

```yaml
contract:
  goal: "Complete Standard Swarm v2 Phase 1 lifecycle evidence gates"
  non_goals:
    - "Phase 2 review quality scoring"
    - "Dashboard UI changes"
  commit_policy: "do not commit"
  main_checkout: "read_only"
  worktree_naming: "<agent>-<task-slug>"
  live_runs:
    allowed: "milestone_only"
    approval_required: true
  done:
    local_validation: "required"
    full_live_validation: "required for final complete"
```

### Phase 0 Gate

Do not start agents until this gate passes:

- source packet exists
- validation commands are written down
- worktree names are assigned
- live-run policy is explicit
- handoff template exists
- review template exists

## Phase 1: Isolated Parallel Implementation

The orchestrator creates worktrees from the same base commit.

Required pattern:

```text
../claude-<task-slug>
../pi-<task-slug>
../codex-<task-slug>
```

User-specific rule from this run:

```text
Codex worktrees must be named codex-...
```

Each agent gets:

- same source packet
- same done criteria
- assigned role bias
- no access to other agents' candidate work during implementation

### Role Biases

Assign these explicitly. They should bias attention, not limit scope.

| Role | Primary question | Phase 1 evidence |
|---|---|---|
| Live Debugger | What fails only in the live runtime? | Claude found the pipefail bug and live-run blockers |
| Architect | Where should the behavior live permanently? | Pi produced the structural lead-only config and synthesis template |
| Defensive Tester | How could this false-pass? | Codex produced worker-spawn and contract-leak gates |

### Phase 1 Agent Rules

Agents must:

- work only in assigned worktree
- avoid commits unless the contract allows them
- keep unrelated dirt out of their diff
- update docs as they go
- run agreed validation before claiming complete
- write a handoff whether complete or incomplete

Agents must not:

- edit the main checkout
- inspect another candidate worktree during implementation
- claim live success without artifact evidence
- broaden scope without recording a decision

## Phase 2: Handoff Gate

Every agent writes a handoff.

Suggested path:

```text
.planning/<run-slug>/handoffs/<agent>-handoff.md
```

Required handoff template:

```markdown
# Agent Handoff

Agent:
Runtime/model:
Status: complete | incomplete | blocked
Worktree:
Branch:
Base commit:
Commit status:
Dirty files:

## Goal

## Files Changed

| File | Change | Why |
|---|---|---|

## Validation

| Command | Result | Evidence |
|---|---|---|

## Live Evidence

Artifact dir:
Session IDs:
Trace paths:
Canonical artifact paths:
Final PASS/FAIL line:
Timeout:
Cost:

## Known Gaps

## Recommended Merge Base

## Review Focus
```

### Handoff Gate Failure Conditions

Mark handoff incomplete if:

- worktree path is missing
- branch is missing
- changed files are not listed
- validation commands are summarized without results
- live claims lack artifact dir
- live claims lack session IDs
- live claims lack trace paths
- known failures are omitted

Incomplete handoff does not discard the work. It limits how strongly the work can be used as completion evidence.

## Phase 3: Pairwise Cross-Review

Each agent reviews each other agent.

For N agents, produce `N * (N - 1)` reviews.

Required path:

```text
.planning/reviews/<reviewer>-review-<subject>-<run-slug>.md
```

Required review structure:

```markdown
# <Reviewer> Review of <Subject>

## Verdict

accept | conditional_accept | useful_input_only | reject

## Findings

### P0
### P1
### P2

## Convergence

| Area | Subject | Reviewer | Assessment |
|---|---|---|---|

## Unique Contributions Worth Porting

## Evidence Gaps

## Merge/Base Recommendation

## Required Follow-Up
```

### Review Requirements

Each review must answer:

- What did the subject get right?
- What did the subject uniquely find?
- What bugs or risks remain?
- Is this a candidate base or only a source of deltas?
- What exact deltas should be ported?
- What evidence is missing?

Reviews should cite files and line numbers when available.

## Phase 4: Convergence Synthesis

Only one synthesis should be produced.

The synthesis should not be a long recap. It should produce a decision matrix.

Required path:

```text
.planning/reviews/<run-slug>-synthesis.md
```

Required sections:

1. final verdict
2. convergence matrix
3. base branch decision
4. accepted deltas to port
5. rejected/deferred deltas
6. final validation checklist
7. evidence gaps

### Convergence Matrix Template

```markdown
| Decision / Fix | Claude | Pi | Codex | Status | Action |
|---|---|---|---|---|---|
| Lead-only cert | yes | yes | yes | accepted | keep |
| Pipefail fix | yes | ported | partial | accepted | verify in final |
| Worker-spawn rejection | no | no | yes | port_to_base | port |
| Non-synthesis contract gate | no | no | yes | port_to_base | port |
| Full live evidence | partial paths | no | incomplete | needs_evidence | rerun final |
```

Allowed status values:

- `accepted`
- `port_to_base`
- `reject`
- `defer`
- `needs_evidence`
- `needs_user_decision`

## Phase 5: Consolidation

Pick exactly one base branch.

Base selection criteria:

1. clean worktree discipline
2. coherent architecture
3. minimal unrelated changes
4. strongest source-of-truth placement
5. validation evidence
6. ease of review

The base is not necessarily the agent with the most tests or the first live pass.

For Phase 1, the reviews indicate:

```text
Base: Pi
Port from Codex: defensive hardening gates and typed leadOnly state
Confirm from Claude: pipefail fix and live-runtime fixes
```

### Consolidation Rules

Port deltas intentionally. Do not merge candidate branches wholesale.

For each accepted delta, record:

```markdown
| Delta | Source agent | Files | Ported? | Validation |
|---|---|---|---|---|
```

If a delta is rejected, record why.

## Phase 6: Final Validation

Run validation from the final consolidated branch only.

For Standard Swarm v2 Phase 1:

```bash
scripts/certify-live-swarm-test
scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
just check
bun test engine/team-execution.test.ts
bun test
git diff --check
```

Then, with explicit approval:

```bash
MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
```

### Final Validation Must Prove

For Phase 1, final evidence must prove:

- clean fixture passes
- seeded fixture passes for the right reason
- failing fixture passes because the harness detects failure correctly
- all required leads completed
- no workers spawned in lead-only certification
- no empty output artifact remains unsuperseded
- no non-synthesis artifact emits `CERTIFICATION_CONTRACT`
- canonical artifact contains strict contract block
- readiness parser does not false-pass negative prose
- no operational session failures occurred

## Phase 7: Evidence Archive

Write:

```text
.planning/<run-slug>/FINAL_EVIDENCE.md
```

Required content:

```markdown
# Final Evidence

Final branch:
Final worktree:
Commit hash:
Dirty status:

## Accepted Deltas

## Rejected / Deferred Deltas

## Validation Commands

| Command | Result | Notes |
|---|---|---|

## Live Evidence

Artifact dir:
Session IDs:
Trace paths:
Canonical artifacts:
Final output:
Cost:
Timeout:

## Residual Risk

## Completion Verdict
```

Completion verdicts:

- `complete`
- `complete_with_known_risk`
- `incomplete`
- `blocked`

## Stop Conditions

Stop and ask for human direction if:

- final live validation requires approval
- no candidate has a clean base branch
- reviews disagree on the base
- validation evidence conflicts across agents
- consolidation would require destructive git operations
- unrelated dirty files are mixed into candidate diffs
- live artifacts cannot be found
- the final branch cannot reproduce individual-agent success

## Phase 1 Lessons Encoded

### Lesson 1: Independent convergence is strong evidence

All three agents independently converged on:

- lead-only certification
- degraded cert steps
- operational/substantive split
- canonical contract artifact selection
- `lead_only` type/config support
- configurable timeout

These should be treated as accepted architecture, not reopened repeatedly.

### Lesson 2: Unique misses are the reason to run parallel agents

No single agent found the full solution:

- Claude found the live shell `pipefail` bug.
- Pi found the best architecture and prompt template.
- Codex found false-pass gates and stronger typed control flow.

The protocol must mine unique deltas, not simply rank agents.

### Lesson 3: The harness is a trust boundary

Most critical bugs were in the certification harness, not the TypeScript engine. Shell scripts used as release/certification gates need:

- regression fixtures
- exact parser tests
- explicit artifact source checks
- no broad prose regexes for contract truth
- careful `set -euo pipefail` handling

### Lesson 4: Handoff quality controls review quality

A live pass without absolute artifact/session evidence is weaker than an incomplete result with exact trace paths. The protocol should reward reproducibility over confidence.

### Lesson 5: Worktree discipline is part of correctness

Main-repo edits during parallel work are not just messy. They can contaminate evidence, hide unrelated changes, and make merge provenance unclear.

## Minimal MAE Implementation

The first MAE implementation does not need full autonomy.

MVP command:

```bash
mae protocol evidence-driven-parallel-review .planning/standard-swarm-v2
```

MVP behavior:

1. Create/verify worktrees.
2. Generate handoff/review templates.
3. Launch or instruct agents with role biases.
4. Validate handoff completeness.
5. Collect pairwise reviews.
6. Generate convergence matrix.
7. Ask for consolidation approval.
8. Run configured validation commands.
9. Write `FINAL_EVIDENCE.md`.

## Chain Sketch

```yaml
evidence-driven-parallel-review:
  description: "Parallel implementation, cross-review, convergence, consolidation, and final evidence"
  inputs:
    packet_path: ".planning/<run-slug>"
    agents: ["claude", "pi", "codex"]
    live_validation_requires_approval: true
  phases:
    - name: contract_lock
      type: deterministic
      outputs:
        - HANDOFF_TEMPLATE.md
        - REVIEW_TEMPLATE.md
    - name: isolated_implementation
      type: parallel_agents
      isolation: worktree
      communication: none
      required_output: handoff
    - name: handoff_gate
      type: deterministic
      fail_on_missing:
        - worktree
        - branch
        - files_changed
        - validation_results
    - name: pairwise_review
      type: parallel_reviews
      read_only: true
      output_pattern: ".planning/reviews/<reviewer>-review-<subject>.md"
    - name: convergence_synthesis
      type: synthesis
      max_outputs: 1
      required_output: CONVERGENCE_MATRIX.md
    - name: consolidation
      type: human_or_agent_guided
      rule: "one base, explicit deltas"
    - name: final_validation
      type: deterministic
      source: "VALIDATION.md"
    - name: evidence_archive
      type: deterministic
      output: FINAL_EVIDENCE.md
```

## Final Recommendation

Adopt `evidence-driven-parallel-review` as the MAE protocol for high-risk implementation work.

For Standard Swarm v2 Phase 1, the protocol's immediate output should be:

1. Pi branch as consolidation base.
2. Codex hardening gates ported.
3. Claude pipefail/live-runtime fixes confirmed.
4. Final validation rerun from the consolidated branch.
5. Exact live evidence archived before Phase 1 is marked complete.

