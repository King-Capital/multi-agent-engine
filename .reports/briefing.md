# Multi-Agent Engine — Current State

## What Works
- **Version:** v1.0.22 deployed to 10.71.20.72
- **Phase 1 complete:** Lifecycle evidence gates — lead-only certification, degraded cert steps, canonical artifact selection, 36 harness regression tests. Live Pi 3-fixture certification PASS.
- **Phase 2 complete:** Participant presence lifecycle — 5 event types (start/activity/heartbeat/stale/end), auto-emit from agentSpawn/agentDone/toolCall/costUpdate, coarse capability metadata, stale detection.
- **Certification harness:** `scripts/certify-live-swarm` with lead-only mode (~$0.35/fixture), isolated trace dir, strict CERTIFICATION_CONTRACT validation, worker-spawn rejection, contract-leak detection.
- **Multi-agent protocol:** Cross-Agent Convergence Review Protocol codified in `.planning/reviews/full-review/claude-consolidated-protocol.md`. Tested with 3 agents on Phases 1+2.
- **Auto-version:** Workflow pushes version bumps directly to main + tags inline. No more intermediate PRs.
- **Adapters:** echo, pi, a2a available. Pi adapter handles empty output as FAILED with findings.
- **Dashboard:** React SPA deployed. Participant SSE events registered.

## What's Left

### P0 — Phase 3: Deterministic Validator
1. `VALIDATION_CONTRACT` schema definition
2. Deterministic evidence checks (lifecycle, scope, contract consistency)
3. Validator wired into strict cert path
4. `REVIEW_REPORT` vs `CERTIFICATION_CONTRACT` boundary validation

### P1 — Follow-up from Phase 2
5. Wire `ParticipantTracker` into orchestrator (Phase 6 dependency)
6. Map "scout" role in `participantKindForRole`
7. Clean up dead `ParticipantEventData` type
8. camelCase/snake_case consistency cleanup

### P1 — From external review
9. Close Ralph loop (#341) — wire applyMutation into runRalphLoop
10. Cost tracking silent $0 (#342)
11. Trace backup to TrueNAS (#343)
12. Delete legacy templ files (#344)
13. Inter-squad dispute resolution (#347/#351)

## Version: v1.0.22
## Recent PRs: #354 (Phase 1), #358 (Phase 2)

---

**Last session:** 2026-05-18 -- Standard Swarm v2 Phase 1+2 (78E39BA8)
**Done:** Phase 1 lifecycle gates (PR #354) | Phase 2 participant presence (PR #358) | 3-agent parallel protocol | external review → 8 issues | auto-version fix | v1.0.22
**Decisions:** lead-only cert | Pi merge base | coarse capabilities | FEEDBACK→blocked status | auto-version direct push | multi-agent convergence protocol
**Blockers:** none
**Carry-forward:** Ralph loop closure #341 | cost tracking #342 | trace backup #343 | legacy templ #344 | inter-squad dispute #347
**Next:** Phase 3 deterministic validator | scout role mapping | ParticipantEventData cleanup

---

**Last session:** 2026-05-18 -- Standard Swarm v2 PRD Review + Planning Skill (C0B45C18)
**Done:** Multi-pass PRD review with 3 AI reviewers | certification foundation gap identified (#318-#321) | structured-goal-run skill installed
**Decisions:** planning docs as source of truth | certification foundation issues are v2 prerequisites
**Blockers:** none

---

**Last session:** 2026-05-13 -- FOSS Prep Verification & Squash Merge (330A8926)
**Done:** Full grep audit of PR #260 | IPs clean, git history clean | PR #260 squash-merged as dd0d5a4b
**Decisions:** Proxmox hostnames acceptable for public | Agent persona names are product identity
**Blockers:** none

---

**Last session:** 2026-05-12 -- RC1 Release Hardening (AEDFB6E9)
**Done:** PR #241-243 fixes | A2A on remote hosts | v1.0.4 deployed | stale sessions auto-close
**Decisions:** A2A optional | stale = completed | atomic self-update

---

**Last session:** 2026-05-10 -- Design Specialist + Standard Swarm Squads (85743FF0)
**Done:** #180 design specialist | standard swarm 5 squads | buildStreamHandler | 46 new tests | filed #187-192 | PR #193
**Decisions:** Bun.serve() gallery | 5 squads over Red/Blue | 180s stall threshold
