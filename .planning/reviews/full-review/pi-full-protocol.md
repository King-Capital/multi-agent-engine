# MAE Cross-Agent Convergence Protocol — Pi Consolidated Version

Date: 2026-05-18
Author: Pi / Opus 4.6
Derived from: Three protocol proposals in `full-review/` plus 11 peer review files in `.planning/reviews/`

---

## What this is

A repeatable protocol for running multiple agents on the same implementation scope in parallel, cross-reviewing, converging, consolidating, and producing trusted merge evidence. Designed to be executable by a human orchestrator today and automatable as an MAE chain later.

---

## When to use

Use when:
- A missed defect is more expensive than 3x parallel implementation cost
- The scope has clear acceptance criteria and validation commands
- Independent approaches could surface different failure classes
- You need merge evidence, not just "it works on my machine"

Do not use for routine single-file fixes.

---

## Protocol phases

```
0. Lock  →  1. Spawn  →  2. Work  →  3. Handoff  →  4. Review  →  5. Converge  →  6. Consolidate  →  7. Validate  →  8. Archive
```

---

## Phase 0 — Lock

Before any agent starts, the orchestrator locks:

### 0.1 Scope contract

```yaml
scope:
  goal: "<one sentence>"
  prd: "<path to PRD or task doc>"
  tasks: "<path to TASKS.md>"
  files_in_scope: ["engine/**", "scripts/certify-*", "agents/teams/chains.yaml"]
  non_goals: ["Phase 2+ work", "dashboard changes"]
```

### 0.2 Conventions

```yaml
conventions:
  worktree_prefix: "pi-"                       # all worktrees start with this
  branch_pattern: "<prefix>-<task-slug>"
  commit_policy: "stage only until consolidation"
  main_repo: "read-only during parallel work"
  live_validation: "milestone-only, requires explicit approval"
```

### 0.3 Done criteria

Machine-checkable. Not prose. Each command has an expected exit/output pattern.

```yaml
done:
  local:
    - { cmd: "scripts/certify-live-swarm-test", expect: "exit 0" }
    - { cmd: "bun test", expect: "0 fail" }
    - { cmd: "just check", expect: "exit 0" }
    - { cmd: "scripts/certify-live-swarm --only failing --dashboard-url ...", expect: "CERTIFICATION PASS" }
    - { cmd: "git diff --check", expect: "exit 0" }
  live:
    - { cmd: "MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi ...", expect: "CERTIFICATION PASS", approval: true }
```

### 0.4 Role assignments (optional but recommended)

Assign complementary review biases so agents don't all optimize the same dimension.

| Role | Bias | Phase 1 example |
|------|------|-----------------|
| Live debugger | "What fails only at runtime?" | Claude |
| Architect | "Where should this live permanently?" | Pi |
| Defensive tester | "What if the invariant silently breaks?" | Codex |

---

## Phase 1 — Spawn

Create one worktree per agent from the same base commit.

```bash
git worktree add ../pi-<slug>-agent1 -b pi-<slug>-agent1 HEAD
git worktree add ../pi-<slug>-agent2 -b pi-<slug>-agent2 HEAD
git worktree add ../pi-<slug>-agent3 -b pi-<slug>-agent3 HEAD
```

Communicate to each agent before it starts:
- Its worktree path
- The scope contract
- The done criteria
- The handoff template (Phase 3)
- That the main repo is read-only
- That it must not read other agents' worktrees

---

## Phase 2 — Work

Each agent works independently. No coordination. Same source docs.

### Orchestrator monitors

- Cost per agent (approve live runs individually)
- Timeout behavior (agents spinning without progress)
- Scope drift (no Phase 2+ work)

### Do not stop agents mid-debug

**Lesson:** Codex had the strongest harness (34 tests, 2 unique gates) but was stopped mid-debug and couldn't be the merge base. If an agent is actively diagnosing a specific failure, give it a bounded extension (10-15 min) rather than killing it. The diagnostic work in progress is often the most valuable part.

---

## Phase 3 — Handoff

When an agent finishes or is stopped, it must produce a structured handoff. Missing fields = incomplete handoff = cannot be used as merge base.

```markdown
# Handoff

## Status: PASS | FAIL | INCOMPLETE

## Identity
- Agent: <name>
- Model: <model>
- Worktree: <absolute path>
- Branch: <branch name>
- Commit status: staged | committed | uncommitted

## Changes
### Tracked
- <path> — <what changed>

### Untracked/new
- <path> — <what it is>

### Excluded
- <path> — <why not included>

## Validation
| Command | Result | Detail |
|---------|--------|--------|
| `scripts/certify-live-swarm-test` | pass | 34 checks |
| `bun test` | pass | 556 pass, 1 skip |
| ... | ... | ... |

## Live evidence (if run)
- Artifact dir: <absolute path>
- Session IDs: { clean: <uuid>, seeded: <uuid>, failing: <uuid> }
- Trace paths: [<absolute paths>]
- Canonical artifact: <absolute path>
- PASS/FAIL line: <exact output>
- Timeout used: <seconds>
- Cost: <USD>

## Known gaps
- <what didn't pass or wasn't attempted>

## Self-assessment
- <honest evaluation: what is strong, what is weak, what was in progress when stopped>
```

**Lesson:** Claude's handoff named `mae-cert.XayLua` without absolute paths — both other agents flagged it as unverifiable. Codex's handoff included exact paths and an honest "I didn't finish" — that was more useful.

---

## Phase 4 — Review

Each agent reviews each other agent. Produces `N*(N-1)` review files.

### File naming

```
.planning/reviews/<reviewer>-review-<reviewed>-<slug>.md
```

### Review template

```markdown
# <Reviewer> Review of <Reviewed>

## Verdict: accept | conditional-accept | useful-input-only | reject

## Convergence table
| Decision | Reviewer | Reviewed | Match |
|----------|----------|----------|-------|
| Lead-only cert | yes | yes | exact |
| ... | ... | ... | exact / differs / missing |

## Unique contributions worth porting
1. <description> — <file:line> — <why it matters>

## Bugs found
1. <P1/P2> — <description> — <file:line> — <reproduction>

## Concerns
1. <description> — <risk> — <recommendation>

## Evidence gaps
1. <what's claimed but not independently verifiable>

## Merge recommendation
<use as base | cherry-pick from | reject>
```

**Lesson:** Claude's convergence table was the single most useful artifact format across all 11 reviews. It instantly shows agreed vs contested vs missing.

---

## Phase 5 — Converge

One synthesis document. Not one per agent.

### File naming

```
.planning/reviews/<designated>-synthesis-<slug>.md
```

### Must answer

1. **Convergence matrix** — what all agents agreed on (high-confidence, stop debating)
2. **Unique contributions** — what each agent found that others missed (cherry-pick candidates)
3. **Merge base selection** — which worktree and why
4. **Port list** — exact items to bring from non-base agents, with file references
5. **Reject list** — what was considered and declined, with reason

### Merge base selection criteria

Ranked:
1. Cleanest worktree discipline (no dirt, no main-repo edits)
2. Most architecturally sound (fixes at the right layer)
3. Best validation evidence
4. Fewest bugs found by reviewers
5. Most complete documentation updates

---

## Phase 6 — Consolidate

Work happens in the merge base worktree only.

### 6.1 Port accepted items

For each item on the port list from Phase 5:

```bash
# diff the specific file from the source agent
git -C ../pi-<slug>-source diff -- <file>

# apply or manually port into the base worktree
# validate after each port category
```

Port categories (validate after each):
- Bug fixes
- Type safety improvements
- Defensive gates / regressions
- Prompt engineering
- Parser hardening
- Structural config changes

### 6.2 Do not blindly merge branches

Never `git merge` another agent's branch. Port explicit accepted deltas from the convergence matrix. Blind merges risk pulling in rejected decisions, unrelated changes, or conflicting approaches.

---

## Phase 7 — Validate

Run every done criterion from Phase 0.3 against the consolidated branch. Do not reuse validation from individual agent worktrees — the consolidated state is different.

```bash
scripts/certify-live-swarm-test
bun test
just check
scripts/certify-live-swarm --only failing --dashboard-url ...
git diff --check

# Then, with explicit approval:
MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --dashboard-url ...
```

If any command fails, fix in the consolidated branch and re-validate. Do not declare done while any required check fails.

---

## Phase 8 — Archive

Write final evidence to the planning docs.

```
.planning/<protocol-run>/FINAL_EVIDENCE.md
```

Required:
- Consolidated branch/worktree
- Final commit hash (if committed)
- Every validation command with exact result
- Live evidence: artifact dir, session IDs, trace paths, canonical artifact, PASS line, cost
- Convergence matrix (final state)
- Port list with status (ported / rejected / deferred)
- Known residual risks
- Process lessons for next run

If live validation was skipped, say so plainly. Phase completion is downgraded to "local-only."

---

## Stop conditions

The protocol pauses and asks the user when:

- No candidate has reproducible validation evidence
- Agents disagree on the merge base after synthesis
- Live evidence contradicts deterministic tests
- Consolidation requires destructive git operations
- A required live validation needs approval
- The main checkout has unrelated dirt that would contaminate a merge
- Any agent claims "done" without evidence matching the handoff template

---

## Agent strength profiles (observed)

| Profile | Finds | Misses | Best for |
|---------|-------|--------|----------|
| Live debugger | Runtime bugs, shell gotchas, process failures | Defensive enforcement, type safety | Finding bugs through execution |
| Architect | Root-cause fixes, structural config, prompt engineering | Shell-level edge cases | Merge base, design decisions |
| Defensive tester | Missing gates, parser false positives, type safety gaps | May not finish live runs | Harness hardening, regressions |

The value of parallel agents is not speed. It is that complementary blind spots overlap less than any single agent running longer.

---

## Cost model (observed from Phase 1)

| Activity | Cost |
|----------|------|
| Local runs per agent (echo, bun test, typecheck) | ~free |
| Live Pi failing-only per agent (lead-only) | ~$0.35 |
| Full 3-fixture live Pi per agent (lead-only) | ~$1.05 |
| Full 3-fixture live Pi (old worker mode) | ~$6.00 |
| Total Phase 1 multi-agent cost | ~$15-20 |

Value produced: 3 independent bug classes found, 13 consolidation items identified, zero ambiguity on merge path, architecture validated through independent convergence.

---

## Anti-patterns to avoid

| Anti-pattern | What happened in Phase 1 | Rule |
|-------------|-------------------------|------|
| Working in main repo | Claude edited main checkout with unrelated dirt | Each agent gets a worktree; main is read-only |
| Vague handoff evidence | Claude named `mae-cert.XayLua` without full paths | Handoff template is mandatory with absolute paths |
| Stopping mid-debug | Codex stopped while diagnosing full-live blocker | Give bounded extension for active debug loops |
| Multiple syntheses | 4 synthesis docs with overlapping content | One synthesis per review round |
| Naming disagreement | 3 agents used 3 different conventions | Agree on naming before agents start |
| Prose "done" criteria | 3 agents had 3 different "done" thresholds | Machine-checkable commands with expected outputs |
| Reusing old validation | Individual agent evidence used for consolidated branch | Re-validate from consolidated state |

---

## Future: MAE chain shape

```yaml
cross-agent-convergence-review:
  description: "Parallel implementation with cross-review, convergence, and consolidation"
  steps:
    - deterministic:
        command: "mae protocol setup-worktrees --count 3 --prefix pi-"
        label: "Create isolated worktrees"
    - parallel:
        - team: Agent A
          lead_only: true
        - team: Agent B
          lead_only: true
        - team: Agent C
          lead_only: true
    - deterministic:
        command: "mae protocol validate-handoffs"
        label: "Check handoff completeness"
    - parallel:
        - team: Review AB (lead_only, read_only)
        - team: Review AC (lead_only, read_only)
        - team: Review BA (lead_only, read_only)
        - team: Review BC (lead_only, read_only)
        - team: Review CA (lead_only, read_only)
        - team: Review CB (lead_only, read_only)
    - team: Synthesis
      lead_only: true
      till_done:
        - "Convergence matrix produced"
        - "Merge base selected"
        - "Port list with accept/reject"
    - team: Consolidation
      till_done:
        - "All accepted items ported"
        - "Local validation passed"
        - "Live validation passed (if approved)"
        - "FINAL_EVIDENCE.md written"
```

This is aspirational. The protocol works today as a human-orchestrated workflow. The chain shape is for when MAE supports worktree-per-agent orchestration natively.
