# Multi-Agent Engine — Current State

## What Works
- **Design specialist (#180)** — designer persona, Bun.serve() gallery with security hardening, reference loader (file/URL/project), `mae design` CLI (session/review/build modes), Design team, design-review + design-build chains
- **Standard swarm** — 5 specialist squads (Correctness, Adversarial, Quality, Security, Domain) x 7 agents each (1 lead + 6 workers), cross-model coverage (Opus/Sonnet/GPT-5.5), SWARM MODE system_prompt_append for aggressive lead behavior
- **Stream handler extraction** — `buildStreamHandler()` replaces 4 duplicated inline callbacks, shared across chain-runner + team-execution
- **orchestratorLoop visibility** — piped through TeamExecutionDeps so the loop sees all team agent activity (tool calls, costs)
- **Lead lifecycle** — leads stay "running" on dashboard until session closes, not after briefing
- **305 tests** — +46 new (chain-runner pure functions + cli-utils edge cases), all passing
- **Previous work intact** — active orchestrator (#174), severity auto-pause (#161), 9 specialist personas (#168), parallel budget isolation (#162), interactive TUI (#183), team wizard (#184), Pi-only adapters

## What's Left (Priority Order for RC1)

### P0 — Blocking release
1. **#192 Session auto-close** — sessions stay "active" forever after chain completes. Fix: `session.status = "completed"` in `chain-runner.ts:runChain()` finally block + `orchestrator.ts:run()` finally block. Also: integration tests leave ghost sessions.
2. **Orphaned Pi processes** — dashboard session close doesn't kill Pi adapter child processes. Need PID tracking in Pi adapter + SIGTERM on session close/shutdown. Not yet filed as issue.

### P1 — Dashboard UX (swarm unusable at scale without these)
3. **#189 Team grouping in agent tree** — 30+ agents render flat. Need bordered group boxes or staggered layout per squad. File: `dashboard-next/src/components/AgentGraph.tsx`
4. **#187 Clickable agents + status filter buttons** — click agent node → detail panel below tree. Click running/done/error/blocked → filter list. File: `dashboard-next/src/components/AgentGraph.tsx` + new `AgentDetail.tsx`

### P2 — Engine hardening
5. **#190 Concurrency cap** — 30+ agents spike local CPU. Configurable `max_total_agents`, `max_per_team`, `stagger_ms` in config
6. **Worktree uncommitted files** — swarm worktrees miss new files. Either commit first or copy mechanism
7. **a2a.ts over 750 lines** — LAW 9 violation, carried 3 sessions

### P3 — Future
8. **#191 Swarm self-improvement loop** — analyze session output → tune prompts → re-run
9. **#185 TUI testing harness**
10. **#168 Phase B: Dynamic team creation**

## Version: v0.2.60 (main, post-PR #193 merge)
## Open Issues: #187, #189, #190, #191, #192, #185, #180, #138, #104

---

**Last session:** 2026-05-10 -- Design Specialist + Standard Swarm Squads + Engine Hardening (85743FF0)
**Done:** #180 design specialist (persona, gallery, refs, CLI, chains) | standard swarm 5 squads x 7 agents | buildStreamHandler extraction | 46 new tests | orchestratorLoop to team-execution | lead agentDone deferred | IDLE_WARN_MS 180s | integration tests env var | swarm reviews (CC + MAE) all CRITICAL/HIGH fixed | filed #187-192 | PR #193 merged
**Decisions:** Bun.serve() gallery over Go | 5 squads over Red/Blue | leads stay running | system_prompt_append SWARM MODE | 180s stall | metadata-only image refs
**Blockers:** #192 session auto-close | orphaned Pi processes | worktree uncommitted files
**Carry-forward:** a2a.ts >750 lines | orchestrator-as-Pi-session question
**Next:** #192 auto-close | #189 team grouping | #187 clickable agents | orphaned process cleanup | RC1 prep

---

**Previous session:** 2026-05-10 -- Team Wizard + Expertise Authoring + Orchestrator Refactor (D77956BF)
**Done:** #184 full implementation | 4 CLI commands | 4 templates | orchestrator split 844→297 | parallel retry fix | API token leak fix | SSRF protection | efficiency caching | 2-round swarm (15 agents) | /simplify pass | PR #186 merged v0.2.59
**Decisions:** mae expert added beyond spec | raw fetch for CLI LLM calls | fix everything found | isInternalUrl to security.ts | two-round swarm before commit
**Blockers:** none

---

**Previous session:** 2026-05-10 -- MAE Full Audit + Specialist Personas (F679C6EA)
**Done:** PRs #169-179 merged | 9 specialist personas | full swarm audit 45/45 fixed | budget isolation | CC/Codex removed
**Decisions:** Pi-only | Antagonist on all teams | hybrid nudge | never leave findings

---

**Previous session:** 2026-05-09 -- P0/P1 Bug Fixes + Dashboard UX + Deploy Pipeline (938AE28D)
**Done:** 5 P0/P1 engine bug fixes | dashboard UX | deploy pipeline fixes
**Decisions:** client-side dedup | Promise.allSettled | projected budget | JSONL perf tracking

---

**Previous session:** 2026-05-09 -- MAE Issues #146-150 + Real Testing (9F5B1105)
**Done:** All 5 issues (#146-150) | preambles | dashboard fix | real swarm audit ($6.55)
**Decisions:** Per-role preambles | GPT via Codex | fast=sonnet off | separate deploys
