# 2026-05-10 -- Team Wizard + Expertise Authoring + Orchestrator Refactor

**Session ID:** D77956BF-7328-484B-B601-E5BC9DCB3489
**Branch:** feat/team-wizard-184

## Done
- Closed #182 (interactive TUI) and #174 (active orchestrator) — already merged
- Built #184: `mae new-team`, `mae learn`, `mae validate-agent`, `mae expert` commands
- 4 team templates (trading, devops, frontend, research)
- Shared utilities: `llm-gateway.ts`, `cli-utils.ts`
- Split orchestrator.ts 844→297 lines (extracted chain-runner.ts 612 lines)
- Fixed parallel retry CRITICAL (stepResult undefined for parallel paths)
- Fixed API token leak to subprocess env in pi adapter
- SSRF protection, regex injection prevention, path traversal blocking
- Efficiency: orchestrator-loop caching, regex pre-compilation, max_expertise_lines honored
- CLAUDE.md updated, JSDoc added, stale binary names fixed
- Filed #185 (TUI testing harness)
- PR #186 merged as v0.2.59

## Decisions
- `mae expert` added beyond spec — auto-learn + instant REPL for codebase understanding
- Raw fetch for CLI LLM calls, not adapter pattern — adapters are for session-managed delegation
- Fix everything found, not just "our changes" — pre-existing efficiency issues fixed in same PR
- `isInternalUrl` moved to security.ts for reuse
- Two-round swarm review (10 + 5 agents) before commit

## Files Changed
New: chain-runner.ts, cli-utils.ts, expert-session.ts, expertise-builder.ts, expertise-validator.ts, llm-gateway.ts, team-wizard.ts, 4 template YAMLs
Modified: orchestrator.ts, orchestrator-loop.ts, cli.ts, config.ts, types.ts, security.ts, team-execution.ts, pi.ts, CLAUDE.md

## Known Issues
- No tests on new modules (chain-runner.test.ts, cli-utils.test.ts priority)
- cli.ts at 611 lines approaching split
- a2a.ts at 786 lines (pre-existing, over limit)
- onStreamEvent duplicated 7x (extract buildStreamHandler)
- YAML write strips comments (documented)
