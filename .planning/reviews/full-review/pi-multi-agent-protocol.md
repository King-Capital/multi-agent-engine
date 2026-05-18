# Multi-Agent Parallel Work Protocol for MAE

Derived from: Phase 1 Standard Swarm v2 peer review experiment (2026-05-18)
Author: Pi / Opus 4.6
Source evidence: 11 review files in `.planning/reviews/`

---

## Purpose

This protocol codifies what worked and what failed when three agents (Pi, Claude, Codex) ran the same implementation task in parallel, then cross-reviewed. It is designed to be executable by MAE chains, human orchestrators, or future multi-agent coordination tooling.

---

## Phase 0 — Setup (before any agent starts working)

### 0.1 Agree on conventions

Before spawning agents, the orchestrator must establish:

```yaml
conventions:
  worktree_naming: "pi-<task-slug>"           # all agent worktrees use this prefix
  branch_naming: "pi-<task-slug>"             # or agent-specific: "<agent>-<task-slug>"
  commit_policy: "stage only, do not commit"  # or "commit per phase"
  main_repo: "read-only during parallel work"
  handoff_format: "structured"                # see 0.2
  done_criteria: "machine-checkable"          # see 0.3
  synthesis_count: 1                          # one synthesis per review round
```

**Lesson learned:** Claude worked in the main repo while others had worktrees. This created merge risk and dirt contamination. Each agent must get its own worktree. Nobody touches the main checkout.

### 0.2 Define the handoff template

Every agent handoff must include these fields. Missing fields = incomplete handoff.

```yaml
handoff:
  agent: "<name>"
  worktree: "<absolute path>"
  branch: "<branch name>"
  commit_status: "staged | committed | uncommitted"
  files_changed:
    tracked: []
    untracked: []
  validation:
    - command: "<exact command>"
      result: "pass | fail"
      detail: "<count, output summary>"
  live_evidence:
    artifact_dir: "<absolute path>"
    session_ids:
      clean: "<uuid>"
      seeded: "<uuid>"
      failing: "<uuid>"
    trace_paths: []
    canonical_artifact: "<absolute path>"
    pass_line: "<exact PASS output>"
    cost: "<total USD>"
  known_gaps: []
  self_assessment: "complete | incomplete | blocked"
  blocker_if_incomplete: "<description>"
```

**Lesson learned:** Claude's handoff named `mae-cert.XayLua` without absolute paths or session IDs. Two other agents flagged this as unverifiable. Codex's handoff included exact paths and an honest "I didn't finish" — that was more useful than a vague claim of success.

### 0.3 Define machine-checkable done criteria

"Phase complete" must be defined with exact commands and expected outcomes, not prose.

```yaml
done_criteria:
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
    - command: "MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --dashboard-url ..."
      expect: "CERTIFICATION PASS"
      approval_required: true
      evidence_required: true
```

**Lesson learned:** Three agents had three different thresholds for "done." Pi accepted failing-only live pass, Claude required all-fixture live pass, Codex required all-fixture but didn't achieve it. A machine-checkable definition would have prevented this ambiguity.

---

## Phase 1 — Parallel implementation

### 1.1 Spawn agents in isolated worktrees

```bash
# orchestrator creates worktrees before handing off
git worktree add ../pi-<task> -b pi-<task> HEAD
git worktree add ../pi-<task>-agent2 -b pi-<task>-agent2 HEAD
git worktree add ../pi-<task>-agent3 -b pi-<task>-agent3 HEAD
```

Each agent works only in its assigned worktree. The main repo is read-only.

### 1.2 Each agent works independently

- No coordination during implementation.
- Each agent reads the same source-of-truth docs (PRD, TASKS, VALIDATION).
- Each agent produces implementation + validation evidence.
- Each agent fills out the handoff template when done or stopped.

### 1.3 Do not stop agents mid-debug

**Lesson learned:** Codex had the strongest harness (34 tests, 2 unique gates) but was stopped while debugging the full-live blocker. The remaining work was probably minutes. Stopping mid-debug meant the best defensive implementation couldn't be the merge base.

**Rule:** If an agent is actively debugging a specific failure, let it finish the current debug loop before stopping. Set a timeout if needed, but communicate it upfront.

---

## Phase 2 — Cross-review

### 2.1 Each agent reviews each other agent

Produces `N*(N-1)` review files. For 3 agents: 6 reviews.

```
.planning/reviews/<reviewer>-review-<reviewed>.md
```

### 2.2 Review structure

Each review should contain:

```markdown
# <Reviewer> Review of <Reviewed> Phase 1 Work

## Verdict: <accept | conditional-accept | reject>

## Convergence table
| Area | Match |
|------|-------|
| ... | exact / differs / missing |

## Unique contributions worth keeping
### 1. ...

## Concerns
### P1: ...
### P2: ...

## Recommendation
```

**Lesson learned:** Claude's convergence table format was the most useful artifact across all reviews. It instantly shows what's agreed versus contested. Use it as the primary review structure.

### 2.3 Do not produce multiple synthesis documents

**Lesson learned:** Phase 1 produced four synthesis files (`pi-as-gpt5.5.md`, `claude-full-review`, `codex-final-review`, `pi-as-opus.md`) that substantially overlap. One synthesis per review round is enough.

**Rule:** The orchestrator or a designated agent produces one synthesis. Other agents contribute findings to the source reviews, not competing syntheses.

---

## Phase 3 — Consolidation

### 3.1 Pick a base

All Phase 1 reviews unanimously agreed: use the agent with the strongest structural implementation as the base, then port specific improvements from others.

Selection criteria:
1. Cleanest worktree discipline
2. Most architecturally sound implementation
3. Best documentation updates
4. Passing local validation

### 3.2 Port improvements by category

From the reviews, improvements fall into categories:

| Category | Example from Phase 1 |
|----------|---------------------|
| **Bug fix** | Claude's pipefail fix, Pi's exit-code capture fix |
| **Type safety** | Codex's `PreparedTeamStep.leadOnly` typed boolean |
| **Defensive gate** | Codex's worker-spawn rejection, contract-leak detection |
| **Prompt engineering** | Pi's synthesis prompt template |
| **Parser hardening** | Codex's `Certification ready: false` regression |
| **Structural config** | Pi's permanent `lead_only: true` on `swarm-review` |

Port each improvement into the base branch, then validate after each category.

### 3.3 Validate from the consolidated state

Run the exact done criteria from Phase 0.3. Do not reuse validation evidence from individual agent worktrees — the consolidated state is different.

### 3.4 Record durable evidence

The final consolidated branch must have recorded in planning docs:

- Commit hash
- All validation commands with results
- Live evidence with exact paths, session IDs, trace paths
- Which improvements were ported from which agent
- Which improvements were rejected and why

---

## What this protocol encodes from the Phase 1 experiment

### Independent convergence is the strongest design signal

When multiple agents on different model families independently produce the same solution, the solution is correct. Do not second-guess converged decisions. Do second-guess anything that diverged.

### Complementary blind spots are the value of parallel work

| Agent type | Finds | Misses |
|-----------|-------|--------|
| Live debugger (Claude) | Runtime bugs, shell gotchas | Defensive enforcement |
| Architect (Pi) | Root-cause fixes, structural config | Shell-level bugs |
| Defensive tester (Codex) | Missing gates, type safety gaps | May not finish live validation |

The argument for multi-agent parallel work is not speed — it is that no single agent covers the full failure surface.

### The harness matters more than the engine

In Phase 1, every real bug was in the Bash certification harness, not the TypeScript engine. The engine changes were straightforward and converged instantly. The harness is where certification trust lives. Treat harness code as critical infrastructure.

### Honest self-assessment beats vague success claims

Codex calling its own result "fail for Phase 1 full complete" was more useful than a less precise "pass with caveats." Agents should report exactly what passed, what didn't, and what they were doing when stopped.

---

## Protocol as an MAE chain (future work)

This protocol could become an MAE chain definition:

```yaml
multi-agent-review:
  description: "Parallel implementation with cross-review and consolidation"
  steps:
    - deterministic:
        command: "setup-worktrees.sh"
        label: "Create isolated worktrees with conventions"
    - parallel:
        - team: Implementation A
          lead_only: true
        - team: Implementation B
          lead_only: true
        - team: Implementation C
          lead_only: true
    - deterministic:
        command: "collect-handoffs.sh"
        label: "Validate handoff completeness"
    - parallel:
        - team: Cross Review AB
          read_only: true
          lead_only: true
        - team: Cross Review AC
          read_only: true
          lead_only: true
        - team: Cross Review BA
          read_only: true
          lead_only: true
        - team: Cross Review BC
          read_only: true
          lead_only: true
        - team: Cross Review CA
          read_only: true
          lead_only: true
        - team: Cross Review CB
          read_only: true
          lead_only: true
    - team: Synthesis
      lead_only: true
      till_done:
        - "Convergence table produced"
        - "Merge path defined"
        - "Port list with acceptance/rejection"
    - team: Consolidation
      till_done:
        - "All accepted improvements ported"
        - "Full validation from consolidated state"
        - "Durable evidence recorded"
```

This is speculative — the point is that the protocol is structured enough to become a chain once the tooling supports worktree-per-agent orchestration natively.
