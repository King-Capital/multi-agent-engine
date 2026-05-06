# 2026-05-06 -- Dashboard SSE + Pi RPC + Full Swarm Review

**Session ID:** E8B6E042-3742-4D9D-BCFF-CCFE12494CCB
**Branch:** test-swarm

## Done
- Dashboard SSE migration (replaced all HTMX polling)
- Dashboard main.go split (1211→288 lines + 3 handler files)
- Pi adapter rewrite: `--print` → `--mode json` → `--mode rpc` (bidirectional)
- Orchestrator rewrite (1096→600 lines, removed dead code)
- Worker spawning restored with Pi RPC + worktree isolation
- `.pi/` directory with skills + prompts
- `--local` flag for local dashboard testing
- Three-tier message hierarchy (only orch posts to dashboard)
- User message forwarding via SSE → Pi RPC `follow_up`
- WriteTimeout fix (30s→0, was killing SSE)
- Full 5-reviewer swarm audit: 10 CRITICAL, 11 HIGH findings

## Decisions
- Pi as default adapter (cross-model support)
- Pi RPC mode over `--print` (bidirectional communication)
- Orchestrator as process manager, not AI agent
- `--local` flag over editing `.env`
- Removed "archived" status
- `WriteTimeout: 0` for SSE
- Three-tier message hierarchy

## Files Changed
- 20+ files across engine/, dashboard/, configs/, agents/, .pi/, justfile

## Known Issues
- 10 CRITICAL findings from swarm review (mergeWorktree, auth bypass, dead code, race conditions)
- 11 HIGH findings (Pi RPC hang, event ordering, path traversal, dual-store inconsistency)
- Markdown not rendering in SSE messages
- Orchestrator is still a for-loop, not an interactive Pi session
