# MAE Parallel Agent Protocol

Derived from Phase 1 Standard Swarm v2 cross-agent review (2026-05-18).
Three agents (Claude, Pi, Codex) independently implemented the same scope, cross-reviewed each other, and the findings were synthesized into this protocol.

## When to use

Any implementation task where:
- The scope is well-defined (PRD, task list, acceptance criteria exist)
- Independent approaches could surface different failure classes
- The cost of a missed defect exceeds the cost of 3x parallel runs
- You want high-confidence merge evidence, not just "it works on my machine"

## Phase 1: Setup

### 1.1 Define the contract

Before agents start, the user provides:
- Scope document (PRD, task list, or issue set)
- Acceptance criteria with validation commands
- Files in scope
- Known constraints (budget, timeout, live-run policy)

### 1.2 Create worktrees

Each agent gets its own worktree branched from the same base commit.

Naming convention: `{agent}-{descriptor}`
- `claude-phase1-cert-hardening`
- `pi-phase1-standard-swarm-v2`
- `codex-phase1-lead-only-cert`

Enforce this BEFORE agents start. The Phase 1 run had naming inconsistency because the convention was established mid-session.

### 1.3 Rules communicated to all agents

- Work only in your worktree. Do not edit the main repo.
- Do not commit until told to.
- Do not read other agents' worktrees.
- Run the full validation bundle before declaring done.
- Include exact evidence in your handoff (artifact dirs, session IDs, trace paths, PASS output).

## Phase 2: Independent implementation

Each agent works the same scope independently. No communication between agents.

### What the user monitors

- Cost per agent (live Pi runs are expensive — approve individually)
- Timeout behavior (stop agents that are spinning)
- Scope drift (agents should not add Phase 2+ work)

### Agent handoff format

When an agent declares done (or is stopped), it must provide:

```
Status: PASS | FAIL | INCOMPLETE
Branch: exact branch name
Worktree: absolute path
Committed: yes | no

Files changed:
  - path/to/file (what changed)

Validation results:
  - command: result
  - command: result

Live evidence (if applicable):
  - Artifact dir: absolute path
  - Session IDs: uuid per fixture
  - Trace paths: absolute paths
  - Canonical artifact: absolute path
  - PASS/FAIL line: exact output

Known issues:
  - description

Suggested review focus:
  - what to check
```

## Phase 3: Cross-review

Each agent reviews each other agent's implementation. This produces N*(N-1) review documents.

### Review file naming

`.planning/reviews/{reviewer}-review-{reviewed}-{descriptor}.md`

Example: `claude-review-pi-phase1-swarm-v2.md`

### Review structure

Each review must cover:

1. **Convergence** — what decisions match across agents (validates correctness)
2. **Unique contributions** — what this agent found that the reviewer didn't
3. **Bugs** — concrete defects with line numbers and reproduction
4. **Design choices** — decisions that affect non-scope behavior (flag, don't block)
5. **Recommendation** — merge as base / cherry-pick from / reject

### What cross-reviews actually catch

From Phase 1 evidence:

| Review pair | What was found |
|------------|----------------|
| Claude reviewing Pi | pipefail bug in Pi's harness |
| Claude reviewing Codex | Worker-spawn gate and contract-leak gate as unique contributions |
| Pi reviewing Claude | Worktree discipline violation, missing trace evidence in handoff |
| Pi reviewing Codex | `PreparedTeamStep.leadOnly` typed boolean as better design |
| Codex reviewing Claude | Main-repo editing risk, readiness parser false-positive |
| Codex reviewing Pi | pipefail bug confirmation, full live evidence still needed |

No single agent caught all issues. The cross-review matrix found 6 distinct classes of issues.

## Phase 4: Synthesis

After all reviews are complete, one agent (or the user) produces a full synthesis review.

### Synthesis file naming

`.planning/reviews/{agent}-full-review-{descriptor}.md`

### Synthesis must answer

1. What did all agents converge on? (High-confidence decisions)
2. What did each agent uniquely contribute? (Cherry-pick candidates)
3. Which agent is the merge base and why?
4. What is the exact consolidation checklist?
5. What process lessons apply to future runs?

## Phase 5: Consolidation

### 5.1 Pick the merge base

The synthesis review identifies the base branch. Selection criteria:
- Most complete implementation
- Cleanest worktree discipline
- Best live evidence
- Fewest bugs found by reviewers

### 5.2 Cherry-pick from other agents

Apply specific improvements from non-base agents. Each cherry-pick must:
- Be identified in the synthesis review
- Come with a specific file and line reference
- Pass the validation bundle after application

### 5.3 Final validation

The consolidated branch must pass the full validation bundle from a clean state:

```bash
# Local
scripts/certify-live-swarm-test
bun test
just check
scripts/certify-live-swarm --only failing --dashboard-url "$dashboard_url"

# Live (requires approval)
MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --dashboard-url "$dashboard_url"
```

### 5.4 Evidence recording

Record in PROGRESS.md or VALIDATION.md:
- Consolidated branch name
- Final commit hash
- All validation command outputs
- Live run artifact dir, session IDs, trace paths
- Canonical artifact path and contract content

## Observed agent profiles

From Phase 1 data, agents have predictable strengths:

| Agent | Strength | Weakness | Best used for |
|-------|----------|----------|---------------|
| Claude | Live debugging, runtime bug discovery | Lightest engine changes, worst worktree hygiene | Finding bugs through execution |
| Pi | Architecture, prompt engineering, adapter refactoring | Misses shell/runtime edge cases | Structural improvements, merge base |
| Codex | Defensive testing, most gates, most type-safe | May not finish under time pressure | Harness hardening, test coverage |

These profiles should inform which agent's output to trust for which type of decision:
- Runtime behavior questions → check Claude's evidence first
- Architectural decisions → check Pi's approach first
- "Did we miss an edge case?" → check Codex's gates first

## Cost model

Phase 1 actual costs:
- Each agent's local runs: ~free (echo adapter, bun tests)
- Each agent's live Pi failing-only: ~$0.35 per run (lead-only mode)
- Full 3-fixture live Pi: ~$1.05 per run (lead-only mode)
- Full 3-fixture live Pi (old worker mode): ~$6 per run

Total Phase 1 multi-agent cost: ~$15-20 in live Pi runs across all three agents.
Value: found 3 independent bug classes, produced 13 consolidation items, zero ambiguity on merge path.

## Anti-patterns observed

1. **Working in the main repo instead of a worktree.** Creates conflict risk and dirt contamination.
2. **Handoffs without exact evidence paths.** Makes cross-review harder and forces trust instead of verification.
3. **Stopping agents mid-debug.** Loses the diagnostic work in progress. If an agent is actively debugging, give it 10 more minutes.
4. **Naming conventions established mid-session.** Communicate upfront. All three agents used different patterns.
5. **Running full live suites as routine validation.** Live Pi runs should be milestone-only, not feedback loops. Use echo smoke and local tests during development.
