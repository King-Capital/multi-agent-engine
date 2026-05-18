# 2026-05-18 -- Standard Swarm v2 Planning Packet And Skill

**Session ID:** C0B45C18-5E26-4106-B4C3-8E324A5EB523
**Branch:** fix/live-certification-hardening

## Done

- Reworked Standard Swarm v2 PRD into production-hardening scope with v2.1 collaboration deferred behind a decision gate.
- Added certification-foundation issue mapping for #288 and #318-#323/#326 across PRD, tasks, validation, progress, agents, README, workflow, and decisions.
- Added docs-as-source-of-truth and regression-test rules to the execution packet.
- Created Codex workflow analysis and Codex skill draft artifacts under `.planning/standard-swarm-v2/`.
- Installed final portable `structured-goal-run` skill to `/Users/rico/.codex/skills/structured-goal-run/`.

## Decisions

- v2 is lifecycle/validation/spawn/steer/dashboard hardening only; A2A/sub-bus/authority/peer challenge are v2.1.
- Older certification-foundation GitHub issues are prerequisites, not unrelated backlog.
- Pi's final skill version is the canonical installed skill.

## Files Changed

- `.planning/standard-swarm-v2-prd-workflow.md`
- `.planning/standard-swarm-v2-flat-leads.md`
- `.planning/standard-swarm-v2/**`
- `/Users/rico/.codex/skills/structured-goal-run/**`
- `.reports/sessions/C0B45C18-5E26-4106-B4C3-8E324A5EB523.md`

## Known Issues

- Planning docs are untracked in git.
- Skill validator script could not run because `yaml` is missing in the available Python environment.
- Worktree has unrelated dirty `.pi/skills`, engine, chain, and cert harness files.
