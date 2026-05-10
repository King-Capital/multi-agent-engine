# Multi-Agent Engine — Current State

## What Works
- **4 new CLI commands** — `mae new-team` (TUI wizard), `mae learn` (expertise from codebases), `mae validate-agent` (LLM-graded quality), `mae expert` (interactive REPL)
- **Orchestrator split** — clean 297-line lifecycle manager + 612-line chain-runner with dependency injection
- **Dashboard SSE streaming** — genuine server-push via Go channels, React SPA at dashboard-next/
- **Pi RPC adapter** — bidirectional stdin/stdout JSONL with prompt/follow_up/abort
- **Active orchestrator loop** — LLM reasoning every 60s with CONTINUE/PAUSE/REASSIGN/SKIP/SPAWN/ESCALATE actions, cached persona/prompt
- **Interactive TUI** — @clack/prompts for config, session, and team management
- **Security hardening** — SSRF protection, regex pre-compilation, API token excluded from subprocess env, path traversal validation
- **Shared utilities** — `llm-gateway.ts` (LiteLLM client with timeout + model routing), `cli-utils.ts` (getFlag, stripFlags, slugify)
- **4 team templates** — trading, devops, frontend, research with chains
- **Config hot-reload** — mtime-based cache, `max_expertise_lines` now honored
- **Event sourcing** — JSONL + PG persistence, SSE to dashboard

## What's Left
1. **#180 Frontend design specialist** — designer persona, design gallery via Bun.serve(), `design_review` chain step, reference loader. Branch `feat/design-specialist-180` created, plan at `.claude/plans/wobbly-cuddling-mango.md`
2. **#185 TUI testing harness** — tmux-based interactive test agent (issue filed)
3. **Test coverage** — `chain-runner.test.ts` and `cli-utils.test.ts` are highest priority
4. **`buildStreamHandler()` extraction** — 7x duplicated onStreamEvent callback
5. **`cli.ts` command module split** — at 611 lines, split on next command addition
6. **MAE-native 5-agent swarm chain** — user wants the CC review swarm pattern as an MAE chain
7. **Manual testing on deployed environment** — merge → deploy → test on 10.71.20.72:8400

## Version: v0.2.59 (main)
## Open Issues: #180, #185, #138, #104

---

**Last session:** 2026-05-10 -- Team Wizard + Expertise Authoring + Orchestrator Refactor
**Done:** #184 full implementation | 4 CLI commands | 4 templates | orchestrator split 844→297 | parallel retry fix | API token leak fix | SSRF protection | efficiency caching | 2-round swarm (15 agents) | /simplify pass | PR #186 merged v0.2.59
**Decisions:** mae expert added beyond spec | raw fetch for CLI LLM calls | fix everything found | isInternalUrl to security.ts | two-round swarm before commit
**Blockers:** none
**Carry-forward:** more workers per team | orchestrator-as-Pi-session question | a2a.ts over 750 lines
**Next:** #180 design specialist | #185 TUI testing | chain-runner + cli-utils tests | MAE-native swarm chain

---

**Previous session:** 2026-05-06 -- Dashboard SSE + Pi RPC + Full Swarm Review
**Done:** Dashboard SSE migration | Pi RPC adapter rewrite | Orchestrator 1096→600 lines | Worker spawning | .pi/ directory | --local flag | 5-reviewer swarm audit
**Decisions:** Pi default adapter | RPC over --print | Orchestrator as process manager | WriteTimeout: 0
