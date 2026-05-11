# 2026-05-10 -- Design Specialist + Standard Swarm Squads + Engine Hardening

**Session ID:** 85743FF0-DF22-4205-875B-BA8B81946185
**Branch:** feat/design-specialist-180 → merged as PR #193

## Done
- #180 Frontend design specialist: persona, Bun.serve gallery, reference loader, `mae design` CLI, Design team, design-review/design-build chains
- Standard swarm: 5 specialist squads (Correctness, Adversarial, Quality, Security, Domain) x 6 workers each with SWARM MODE system_prompt_append
- `buildStreamHandler()` extraction from 4 duplicated inline handlers
- chain-runner.test.ts (28 tests) + cli-utils.test.ts (18 tests) = 305 total
- orchestratorLoop piped to team-execution (was blind to all team agents)
- Lead agentDone deferred to after workers complete (was firing after brief)
- IDLE_WARN_MS 90s→180s for large swarms
- Integration tests use MAE_DASHBOARD_URL env var
- Gallery bind config via MAE_GALLERY_HOST/MAE_AGENT_HOST
- Swarm review: CC standard (5 agents) + MAE multi-agent (Red+Blue) + MAE standard-swarm (28 agents)
- All CRITICAL/HIGH findings fixed (Bun.file().toString(), SSRF, path traversal, XSS, CSP)
- Filed #187-192 (dashboard UX + engine lifecycle)
- Closed #188 (lead done early — fixed)

## Decisions
- Bun.serve() for gallery over Go dashboard (standalone, 137 lines, live preview)
- 5 specialist squads over Red/Blue reuse (independent leads, cross-model workers)
- Leads stay running until session close (not after briefing)
- system_prompt_append SWARM MODE over new persona files
- 180s stall threshold over 90s (large swarm false positives)
- Image refs as metadata only (OOM + useless truncated base64)

## Files Changed
- 7 new files (stream-handler, design-gallery, reference-loader, 2 test files, persona, expertise)
- 8 modified files (chain-runner, team-execution, orchestrator, cli, integration tests, monitoring, teams.yaml, chains.yaml)
- +1330 -75 lines total

## Known Issues
- #192 Sessions never auto-close
- Orphaned Pi processes on session close
- Worktrees don't include uncommitted files
- #189 Agent tree has no team grouping
- #187 No clickable agents or status filters
