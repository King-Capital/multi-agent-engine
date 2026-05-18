# Cross-Agent Convergence Review Protocol

Consolidated from three independent protocol proposals (Claude, Pi, Codex) derived from the Phase 1 Standard Swarm v2 experiment (2026-05-18). This document takes the strongest elements from each and resolves conflicts.

## Core thesis

Parallel agents are not valuable because they are faster. They are valuable because independent blind spots overlap less. This protocol exists to maximize that complementarity while preventing the chaos that unstructured parallel work creates.

## When to use

Work where a false "done" is expensive and deterministic tests alone are insufficient:

- Release gates and certification harnesses
- Security-sensitive changes
- Adapter/runtime lifecycle changes
- Migrations and infrastructure moves
- Multi-process or distributed workflows

Do not use for routine single-file fixes. The overhead is only justified when independent blind spots matter.

---

## Phase 0 — Plan lock

Before any agent starts, the orchestrator locks:

### 0.1 Scope packet

```
.planning/<run-name>/
  README.md              — goal, non-goals, scope boundary
  TASKS.md               — ordered task list with acceptance criteria
  VALIDATION.md          — exact commands, expected outcomes, live policy
  HANDOFF_TEMPLATE.md    — required handoff fields (see 0.3)
  REVIEW_TEMPLATE.md     — required review structure (see Phase 2)
  CONVERGENCE_MATRIX.md  — empty matrix template (see Phase 3)
  DECISIONS.md           — implementation decisions during the run
```

### 0.2 Conventions

Establish before agents start. Do not change mid-run.

```yaml
worktree_naming: "{agent}-{task-slug}"
branch_naming: "{agent}-{task-slug}"
commit_policy: "stage only, do not commit until told"
main_repo: "read-only during parallel work"
done_criteria: "machine-checkable commands with expected outputs"
synthesis_rule: "one synthesis document per review round"
```

### 0.3 Handoff template

Every agent must produce this when done or stopped. Missing fields = incomplete handoff. MAE should reject handoffs that omit live evidence fields when live runs were performed.

```yaml
agent: ""
model: ""
worktree: ""          # absolute path
branch: ""
commit_status: ""     # staged | committed | uncommitted
self_assessment: ""   # complete | incomplete | blocked

files_changed:
  tracked: []
  untracked: []

what_changed: ""
what_was_not_changed: ""

validation:
  - command: ""
    result: ""        # pass | fail
    detail: ""        # count, summary

live_evidence:        # omit section if no live run performed
  artifact_dir: ""    # absolute path
  session_ids:
    clean: ""
    seeded: ""
    failing: ""
  trace_paths: []     # absolute paths
  canonical_artifact: "" # absolute path
  pass_line: ""       # exact output
  timeout: ""
  cost: ""

known_gaps: []
blocker_if_incomplete: ""
recommended_base: ""  # which agent's branch should be the merge base
```

### 0.4 Machine-checkable done criteria

"Done" is defined by exact commands and expected outputs, not prose.

```yaml
local:
  - command: "scripts/certify-live-swarm-test"
    expect: "exit 0"
  - command: "bun test"
    expect: "exit 0, 0 fail"
  - command: "just check"
    expect: "exit 0"
  - command: "scripts/certify-live-swarm --only failing --dashboard-url ..."
    expect: "CERTIFICATION PASS"

live:
  - command: "MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi ..."
    expect: "CERTIFICATION PASS"
    approval_required: true
    evidence_required: true
```

### 0.5 Agent role assignments (optional but recommended)

Assign complementary biases explicitly so agents lean into their strengths instead of all doing the same thing.

| Role | Bias | Primary job |
|------|------|-------------|
| Live Debugger | "What fails only when the real adapter runs?" | Run the live path, catch runtime/shell bugs, preserve exact artifact evidence |
| Architect | "Where should this behavior live permanently?" | Keep implementation coherent, improve config/engine design, produce cleanest merge base |
| Defensive Tester | "What if the intended invariant silently breaks?" | Add negative gates, find false-pass risks, enforce trust boundaries |

Phase 1 evidence for why this matters:

- Live Debugger (Claude) found the `pipefail` bug — only visible through live execution
- Architect (Pi) produced the synthesis prompt template — root-cause fix for LLM non-determinism
- Defensive Tester (Codex) added worker-spawn rejection and contract-leak gates — enforcement neither other agent thought of

---

## Phase 1 — Isolated agent runs

### 1.1 Create worktrees from same base

```bash
git worktree add ../{agent}-{slug} -b {agent}-{slug} HEAD
```

Each agent works only in its worktree. Main repo is read-only.

### 1.2 Agents work independently

- No coordination during implementation
- All agents read the same scope packet
- Each agent runs the validation bundle before declaring done
- Each agent fills out the handoff template

### 1.3 User monitors

- Cost per agent (approve live runs individually)
- Timeout (stop spinning agents, but see 1.4)
- Scope drift (flag agents adding out-of-scope work)

### 1.4 Do not stop agents mid-debug

If an agent is actively debugging a specific failure, let it finish the current debug loop. Set a time budget upfront if needed, but communicate it before the run starts.

Phase 1 evidence: Codex had the strongest harness (34 tests, 2 unique gates) but was stopped mid-debug. The remaining work was probably minutes. The best defensive implementation couldn't be the merge base because it didn't finish.

---

## Phase 2 — Pairwise cross-review

Each agent reviews each other agent. Produces N*(N-1) review documents.

### 2.1 Review file naming

```
.planning/reviews/{reviewer}-review-{reviewed}-{descriptor}.md
```

### 2.2 Review structure

Reviews must lead with findings, not summaries. This prevents weak "looks good" reviews from hiding blockers.

```markdown
# {Reviewer} Review of {Reviewed}

## Verdict
Accept | Conditional accept | Reject | Useful input only

## Convergence table
| Area | Match |
|------|-------|
| ... | exact | differs | missing |

## Unique contributions worth porting

## Bugs found
(concrete: file, line, reproduction)

## Design choices that affect non-scope behavior
(flag, don't block)

## Evidence gaps

## Recommendation
Merge as base | Cherry-pick from | Reject
```

### 2.3 What cross-reviews catch that self-review misses

From Phase 1:

| Review pair | Found |
|-------------|-------|
| Claude → Pi | pipefail bug in harness |
| Claude → Codex | Worker-spawn gate as unique contribution |
| Pi → Claude | Worktree discipline violation, weak handoff evidence |
| Pi → Codex | Typed `leadOnly` boolean as better design than prompt matching |
| Codex → Claude | Main-repo editing risk, readiness parser false-positive |
| Codex → Pi | pipefail confirmation, live evidence still needed |

Six distinct issue classes found. No single agent found all six.

---

## Phase 3 — Convergence synthesis

One agent (or the user) produces one synthesis document. Not three competing syntheses — that was a Phase 1 anti-pattern.

### 3.1 Convergence matrix (primary artifact)

The matrix replaces long prose. It is the decision record.

| Decision / Fix | Agent A | Agent B | Agent C | Status |
|----------------|---------|---------|---------|--------|
| Lead-only cert | yes | yes | yes | accepted |
| Degraded cert steps | yes | yes | yes | accepted |
| Pipefail fix | yes | ported | partial | must verify |
| Worker-spawn gate | no | no | yes | port to base |
| Contract leak gate | no | no | yes | port to base |
| Full live pass | yes | yes (1 fixture) | no | rerun from consolidated |

Status values: `accepted` | `port_to_base` | `reject` | `needs_evidence` | `defer`

### 3.2 Synthesis must answer

1. What did all agents converge on? (High-confidence — do not second-guess)
2. What did each agent uniquely contribute? (Cherry-pick candidates)
3. Which agent is the merge base? (Selection criteria in 4.1)
4. Exact consolidation checklist with file references
5. Process lessons for future runs

---

## Phase 4 — Consolidation

### 4.1 Pick the merge base

One branch becomes the base. Selection criteria, in priority order:

1. Cleanest worktree discipline
2. Most architecturally coherent implementation
3. Best source-of-truth placement (config > env var > prompt hack)
4. Fewest unrelated changes
5. Strongest validation evidence
6. Easiest diff to review

### 4.2 Port accepted deltas

From the convergence matrix, port each `port_to_base` item. For each:

- Identify source file and lines from the non-base agent
- Apply to the base branch
- Run targeted validation after each category of ports

Port categories (from Phase 1 evidence):

| Category | Example |
|----------|---------|
| Bug fix | pipefail fix |
| Type safety | `PreparedTeamStep.leadOnly` typed boolean |
| Defensive gate | Worker-spawn rejection, contract-leak detection |
| Prompt engineering | Synthesis CERTIFICATION_CONTRACT template |
| Parser hardening | `certification_ready: false` negation pattern |
| Structural config | Permanent `lead_only: true` on chain definition |

### 4.3 Reject and document

Items marked `reject` in the convergence matrix need a one-line reason in DECISIONS.md. "Not needed" is not a reason — say why.

---

## Phase 5 — Final validation

### 5.1 Run from consolidated state

Do not reuse validation evidence from individual agent worktrees. The consolidated state is different.

Run the exact done criteria from Phase 0.4.

### 5.2 Evidence archive

Write to `.planning/<run-name>/FINAL_EVIDENCE.md`:

```markdown
# Final Evidence

Branch:
Commit:

## Validation
- command: result

## Live evidence
- artifact_dir:
- session_ids:
- trace_paths:
- canonical_artifact:
- pass_line:
- timeout:
- cost:

## Accepted from convergence matrix
(list with source agent)

## Rejected from convergence matrix
(list with reason)

## Residual risk
```

### 5.3 Completion downgrade

If the final live run is skipped or fails, the phase completion must be downgraded and the document must say so plainly. "Local tests pass" is not "Phase complete."

---

## Stop conditions

The protocol pauses and asks the user when:

- No candidate has reproducible validation evidence
- Agents disagree on the merge base with no convergence
- Live evidence conflicts with deterministic tests
- Consolidation requires destructive git operations
- Required live validation needs budget approval
- Main repo has unrelated dirty state affecting the merge
- Any agent claims done without filling the handoff template

---

## Cost model

Phase 1 actuals (3 agents, lead-only certification):

| Item | Cost |
|------|------|
| Local runs per agent | ~free |
| Live Pi per fixture (lead-only) | ~$0.35 |
| Full 3-fixture live Pi | ~$1.05 |
| Full 3-fixture live Pi (old worker mode) | ~$6.00 |
| Total protocol run | ~$15-20 in live Pi |

Value produced: 3 independent bug classes found, 13 consolidation items identified, zero merge-path ambiguity.

Break-even: protocol pays for itself if it catches one bug that would have required a post-merge live debugging session (~$6-12 per debug cycle).

---

## Anti-patterns from Phase 1

| Anti-pattern | What happened | Rule |
|--------------|---------------|------|
| Main-repo editing | Claude edited main repo while others had worktrees | Worktrees only, main is read-only |
| Vague evidence | "Artifacts at mae-cert.XayLua" without absolute paths | Handoff template enforces exact paths |
| Mid-debug stop | Codex stopped while debugging full-live blocker | Budget upfront, don't stop mid-loop |
| Late conventions | Naming convention established after agents started | Lock conventions in Phase 0 |
| Multiple syntheses | Three competing synthesis docs with overlapping content | One synthesis per review round |
| Live as feedback loop | Agents running full live Pi repeatedly during development | Echo smoke + local tests for dev, live for milestones only |

---

## Future: MAE chain definition

This protocol is structured enough to become an MAE chain once worktree-per-agent orchestration is native:

```yaml
cross-agent-convergence-review:
  description: "Parallel implementation, pairwise review, convergence synthesis, consolidation"
  steps:
    - deterministic:
        command: "mae protocol setup-worktrees"
        label: "Create isolated worktrees"
    - parallel:
        - team: Implementation A
          lead_only: true
        - team: Implementation B
          lead_only: true
        - team: Implementation C
          lead_only: true
    - deterministic:
        command: "mae protocol validate-handoffs"
        label: "Check handoff completeness"
    - parallel:
        - team: Review AB
          read_only: true
          lead_only: true
        - team: Review AC
          read_only: true
          lead_only: true
        - team: Review BA
          read_only: true
          lead_only: true
        - team: Review BC
          read_only: true
          lead_only: true
        - team: Review CA
          read_only: true
          lead_only: true
        - team: Review CB
          read_only: true
          lead_only: true
    - team: Synthesis
      lead_only: true
      till_done:
        - "Convergence matrix produced"
        - "Merge base selected"
        - "Port list with accept/reject"
    - team: Consolidation
      till_done:
        - "All accepted deltas ported"
        - "Validation from consolidated state"
        - "Evidence archive written"
```

This is speculative. The first useful version is the manual protocol above with hard evidence gates.
