# Multi-Agent Engine — Current State

## What Works
- **Release state:** `main` is clean and synced to `v1.0.4`; live dashboard health reports DB connected and `version: 1.0.4`.
- **Installed hosts:** local wrapper, Skippy (`10.71.1.21`), and King (`king@10.71.20.120`) are installed at `v1.0.4`; Skippy and King health are `HEALTHY`.
- **Adapters:** Skippy and King have `echo`, `pi`, and `a2a` available. A2A is configured to MonkeyProof A2A at `http://10.71.20.120:3210`.
- **Langfuse:** Skippy and King health checks show Langfuse connected at `http://10.71.20.73:3000`.
- **Installer/update path:** `mae update` wrapper self-update is atomic and symlink-chain aware after PR #242.
- **Stale session lifecycle:** stale `active`, `waiting`, and `paused` sessions auto-close as `completed`; running/idle agents close as done/completed after PR #243.
- **Dashboard deploy:** GitHub `Deploy Dashboard`, `Deploy Engine`, and `Notify Workspace` runs for `v1.0.4` passed.

## What's Left

### P0 — Watch before calling it boring
1. **Controlled real swarm smoke:** run a standard-swarm or scout run on Skippy/King and verify orchestrator events, steer ack, pause/resume/stop, Langfuse cost, and terminal dashboard status.
2. **Large-repo Pi behavior:** confirm PR #241 actually stops the old timeout/nudge spiral under real load.

### P1 — Dashboard / UX
3. **Cost display consistency:** continue watching sidebar/session detail/summary now that event-derived costs and stale close are tighter.
4. **Stale close admin UX:** consider previewing count/session ids before bulk-closing open sessions.

### P2 — Engine hardening
5. **Installer smoke tests:** add installed-wrapper and symlinked-wrapper update tests for the atomic update path.
6. **Issue cleanup:** close/update stale-session issue metadata if PR #243 did not auto-link it.
7. **a2a.ts file length:** still a likely law/rules cleanup item.

## Version: v1.0.4
## Recent PRs: #241, #242, #243

---

**Last session:** 2026-05-12 -- RC1 Release Hardening (AEDFB6E9)
**Done:** PR #241 optional A2A/config/Pi timeout/nudge fixes | MonkeyProof A2A configured on Skippy/King | bad Skippy runs stopped | PR #242 atomic wrapper update with review swarm | PR #243 stale sessions done/completed | v1.0.4 deployed | local/Skippy/King installed and verified
**Decisions:** A2A optional unless configured | MonkeyProof A2A as coding target | stale means completed, not error | atomic self-update only | remote health checks source real MAE env
**Blockers:** none immediate
**Carry-forward:** controlled real swarm smoke | large-repo Pi/nudge verification | cost display watch | installer smoke tests | issue cleanup

---

**Last session:** 2026-05-10 -- Design Specialist + Standard Swarm Squads + Engine Hardening (85743FF0)
**Done:** #180 design specialist (persona, gallery, refs, CLI, chains) | standard swarm 5 squads x 7 agents | buildStreamHandler extraction | 46 new tests | orchestratorLoop to team-execution | lead agentDone deferred | IDLE_WARN_MS 180s | integration tests env var | swarm reviews (CC + MAE) all CRITICAL/HIGH fixed | filed #187-192 | PR #193 merged
**Decisions:** Bun.serve() gallery over Go | 5 squads over Red/Blue | leads stay running | system_prompt_append SWARM MODE | 180s stall | metadata-only image refs
**Blockers:** #192 session auto-close was addressed by PR #243; orphaned Pi process/worktree items may still need re-check
**Carry-forward:** a2a.ts >750 lines | orchestrator-as-Pi-session question

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
