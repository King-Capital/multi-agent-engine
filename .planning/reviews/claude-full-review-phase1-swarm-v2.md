# Claude Full Review — Phase 1 Cross-Agent Analysis

Date: 2026-05-18
Scope: Synthesis of all 6 cross-agent reviews for Standard Swarm v2 Phase 1

## Source reviews

- `claude-review-pi-phase1-swarm-v2.md`
- `claude-review-codex-phase1-swarm-v2.md`
- `codex-review-claude.md`
- `codex-review-pi.md`
- `pi-review-claude-phase1.md`
- `pi-review-codex-phase1.md`

## 1. Independent convergence validates the design

All three agents — without seeing each other's code — produced identical fixes for 8 core problems (chain-runner degraded status, lead-only mode, operational failure separation, canonical artifact selection, types.ts additions, Pi adapter refactoring, echo adapter contract addition, timeout env var). When three independent implementations converge on the same solution, the architecture is correct. There is no ambiguity about the approach.

## 2. Each agent found something the others missed

| Agent | Unique contribution | Why the others missed it |
|-------|-------------------|--------------------------|
| Claude | pipefail bug: `grep -q && printf` silently exits under `set -euo pipefail` | Only found through live testing that hit the success path; unit fixtures did not exercise it |
| Pi | Synthesis prompt template with inline CERTIFICATION_CONTRACT schema and semantic consistency rules | Pi attacked the LLM non-determinism at the source; Claude and Codex only patched it at the harness/prompt level |
| Codex | Worker-spawn rejection gate, non-synthesis contract leak detection gate, typed `PreparedTeamStep.leadOnly` boolean | Codex was the most defensive; it asked "what if lead-only breaks?" and added enforcement, not just implementation |

This is the core argument for multi-agent parallel work: no single agent found all three classes of issues. Together they covered the full surface.

## 3. All six reviews agree on the merge path

Every review — including each agent reviewing itself — converges on: Pi base + Codex harness gates + Claude pipefail fix. Zero disagreement across 6 documents. The consolidated branch needs these items:

From Pi (base):
1. Synthesis prompt template with CERTIFICATION_CONTRACT schema and semantic rules
2. `lead_only: true` as permanent chain config in `chains.yaml`
3. Pi adapter `resultFromFinalText` refactor
4. Pi adapter reverse text block search
5. Incidental `read_only: true` fixes on red-blue and standard-swarm chains

From Codex:
6. Worker-spawn rejection gate (`worker_spawn_count == 0`)
7. Non-synthesis contract leak gate (`non_synthesis_contract_artifacts()`)
8. `PreparedTeamStep.leadOnly` typed boolean (replaces Pi's prompt-string-matching)
9. Lead prompt instruction blocking CERTIFICATION_CONTRACT emission
10. Adaptive timeout (60s echo / 150s Pi)
11. `marks_certification_ready` parser improvement for `certification_ready: false`
12. Extra `delegateToLead` test for explicit lead-only mode

From Claude:
13. pipefail fix: `grep -q && printf` changed to `if grep -q; then printf; fi`

## 4. Agent strength profiles

- **Claude** is the live debugger. Found the runtime bug. Got all 3 fixtures passing first. But lightest engine touch and worst hygiene (worked in main repo, unused worktree left behind).
- **Pi** is the architect. Best adapter refactoring, best prompt engineering, cleanest worktree discipline. But missed the pipefail bug.
- **Codex** is the defensive tester. Most tests (34 vs 29), most gates (worker spawn + contract leak), most type-safe (`PreparedTeamStep.leadOnly`). But did not finish the live run.

## 5. Process lessons

### Worktree discipline matters

Both Pi and Codex flagged Claude's main-repo editing as a risk. If Claude had accidentally committed unrelated `.pi/skills/*.md` dirt, it would have polluted the PR. Future multi-agent runs should enforce worktree-only editing.

### Handoff detail matters

Codex and Pi both flagged that Claude's handoff lacked exact trace paths and session IDs. Claude's full live pass is real but harder to independently verify without absolute artifact paths. Future handoffs should include: artifact dir, session IDs, trace file paths, canonical contract artifact path, and final PASS output line.

### Stopping agents mid-run loses value

Codex was actively debugging the full-live blocker when stopped. Its partial diagnosis (wrapper exited nonzero after sessions completed) would have been resolved with more time. The 34-test harness and defensive gates Codex built are the strongest of the three, but the incomplete live run prevents Codex from being the merge base.

### Naming conventions need upfront agreement

Codex used `codex-*` naming before the `claude-*` / `pi-*` convention was established. This created minor confusion in the review. Convention should be communicated before agents start.

## 6. Validation requirements before Phase 1 merge

All reviews agree the final consolidated branch must pass:

```
scripts/certify-live-swarm-test
bun test
just check
scripts/certify-live-swarm --only failing --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
```

Plus one approved full live Pi run:

```
MAE_CERT_KEEP_ARTIFACTS=1 scripts/certify-live-swarm --live-pi --dashboard-url "${MAE_DASHBOARD_URL:-http://10.71.20.72:8400}"
```

With durable evidence recorded: artifact dir, session IDs, trace paths, canonical artifact paths, PASS output.
