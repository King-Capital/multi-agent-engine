# Multi-Agent Engine — Current State

## What Works
- **Release state:** `main` is at `v1.0.14` with PR #260 FOSS scrub squash-merged (`dd0d5a4b`). All internal IPs scrubbed, git history clean of secrets.
- **FOSS readiness:** Repo cleared for public visibility. Remaining Proxmox hostnames, agent persona names, and platform references reviewed and accepted.
- **Installed hosts:** local wrapper and two remote hosts installed at `v1.0.4`; remote health is `HEALTHY`.
- **Adapters:** `echo`, `pi`, and `a2a` available. A2A configured to MonkeyProof A2A endpoint.
- **Langfuse:** Connected at `LANGFUSE_HOST` env var.
- **Installer/update path:** `mae update` is atomic and symlink-chain aware.
- **Stale session lifecycle:** stale sessions auto-close as `completed`.
- **Dashboard deploy:** GitHub Actions deploys passing.

## What's Left

### P0 — Before going public
1. **Flip repo visibility to public** on GitHub.

### P1 — Post-public
2. **Controlled real swarm smoke:** run a standard-swarm on a remote host and verify orchestrator events, steer, Langfuse cost, and dashboard terminal status.
3. **Large-repo Pi behavior:** confirm nudge suppression and delegate timeout under real load.

### P2 — Dashboard / Engine
4. **Cost display consistency:** sidebar/session detail/summary alignment.
5. **Installer smoke tests:** test `mae update` from installed and symlinked wrappers.
6. **a2a.ts file length:** still above 750-line threshold.

## Version: v1.0.14
## Recent PRs: #259, #260

---

**Last session:** 2026-05-13 -- FOSS Prep Verification & Squash Merge (330A8926)
**Done:** Full grep audit of PR #260 | IPs clean, git history clean, no secrets | Remaining infra/agent refs reviewed and accepted | PR #260 squash-merged to main as dd0d5a4b
**Decisions:** Proxmox hostnames acceptable for public | Agent persona names are product identity | Deploy username = 'skippy' consistent with persona | Repo cleared for public visibility
**Blockers:** none
**Carry-forward:** controlled real swarm smoke | large-repo Pi/nudge verification | cost display watch | stale-session issue cleanup
**Next:** flip repo to public | consider FOSS announcement

---

**Last session:** 2026-05-12 -- RC1 Release Hardening (AEDFB6E9)
**Done:** PR #241 optional A2A/config/Pi timeout/nudge fixes | A2A configured on remote hosts | PR #242 atomic wrapper update with review swarm | PR #243 stale sessions done/completed | v1.0.4 deployed | remote hosts installed and verified
**Decisions:** A2A optional unless configured | stale means completed, not error | atomic self-update only | remote health checks source real MAE env
**Blockers:** none immediate
**Carry-forward:** controlled real swarm smoke | large-repo Pi/nudge verification | cost display watch | installer smoke tests | issue cleanup

---

**Last session:** 2026-05-10 -- Design Specialist + Standard Swarm Squads + Engine Hardening (85743FF0)
**Done:** #180 design specialist (persona, gallery, refs, CLI, chains) | standard swarm 5 squads x 7 agents | buildStreamHandler extraction | 46 new tests | orchestratorLoop to team-execution | IDLE_WARN_MS 180s | swarm reviews all CRITICAL/HIGH fixed | filed #187-192 | PR #193 merged
**Decisions:** Bun.serve() gallery over Go | 5 squads over Red/Blue | leads stay running | 180s stall | metadata-only image refs
**Blockers:** none

---

**Last session:** 2026-05-10 -- Team Wizard + Expertise Authoring + Orchestrator Refactor (D77956BF)
**Done:** #184 full implementation | 4 CLI commands | 4 templates | orchestrator split 844→297 | parallel retry fix | API token leak fix | SSRF protection | PR #186 merged v0.2.59
**Decisions:** mae expert added beyond spec | raw fetch for CLI LLM calls | isInternalUrl to security.ts | two-round swarm before commit

---

**Last session:** 2026-05-10 -- MAE Full Audit + Specialist Personas (F679C6EA)
**Done:** PRs #169-179 merged | 9 specialist personas | full swarm audit 45/45 fixed | budget isolation | CC/Codex removed
**Decisions:** Pi-only | Antagonist on all teams | hybrid nudge | never leave findings
