# Multi-Agent Engine — Current State

## What Works
- **Dashboard SSE streaming** — genuine server-push via Go channels, HTML fragments rendered server-side by templ
- **Pi RPC adapter** — bidirectional stdin/stdout JSONL with prompt/follow_up/abort commands
- **Adapter abstraction** — clean `PlatformAdapter` interface, pi/claude-code/codex/echo/a2a all swappable
- **Event sourcing** — JSONL append-only log with in-memory replay + PG persistence
- **Lead-to-worker delegation** — leads brief workers via `### ASSIGNMENT` blocks, workers spawn in parallel worktrees
- **Config hot-reload** — mtime-based cache invalidation, YAML changes picked up without restart
- **Pi skills** — `.pi/skills/` with conversational-response, active-listener, zero-micro-management, precise-worker, high-autonomy, mental-model

## What's Broken (from 5-reviewer swarm audit)
- **10 CRITICAL findings:** mergeWorktree never called (worker changes destroyed), self-healing/security/budget enforcement all dead code, auth bypass on GETs, CORS wildcard, parallel session race condition, path traversal in slugs/session IDs, agents run with bypassPermissions
- **11 HIGH findings:** Pi RPC hang (no hard kill), event ordering, dual-store inconsistency, unsanitized dashboard messages forwarded to agents, persona file writes without role check
- **Architecture gap:** orchestrator is a TypeScript for-loop, not an interactive Pi session. Dan's pattern has the orchestrator AS a Pi agent using dispatch_agent extension.

## What's Next
1. Fix CRITICAL findings (start with mergeWorktree, auth, path traversal)
2. Fix HIGH findings (Pi RPC hang, event ordering)
3. Markdown rendering in SSE messages
4. More workers per team (5-10 domain experts vs current 2)
5. Consider making orchestrator a Pi RPC session itself
6. Merge test-swarm to main once CRITICALs fixed

## Branch: test-swarm (9 commits ahead of main)

---

**Last session:** 2026-05-06 -- Dashboard SSE + Pi RPC + Full Swarm Review
**Done:** Dashboard SSE migration | Pi RPC adapter rewrite | Orchestrator 1096→600 lines | Worker spawning | .pi/ directory | --local flag | Three-tier messages | WriteTimeout fix | 5-reviewer swarm audit
**Decisions:** Pi default adapter | RPC over --print | Orchestrator as process manager | WriteTimeout: 0 | Removed archived status
**Blockers:** 10 CRITICAL + 11 HIGH findings from swarm review need fixing before merge
**Next:** Fix CRITICALs (mergeWorktree, auth, path traversal) | Fix HIGHs (RPC hang, event ordering) | More team workers | Merge to main
