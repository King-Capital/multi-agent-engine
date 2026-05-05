# Multi-Agent Engine


> All LAWs (#!/bin/bash, protected branches, stack prefs) enforced via ~/.claude/CLAUDE.md and hooks.


## Stack

- **Engine:** Bun + TypeScript. Use `bun` not `npm/yarn`. Use `bun:test` for tests.
- **Dashboard:** Go + templ + chi. Use `templ generate` before `go build`.
- **Config:** YAML files in `configs/` and `agents/teams/`.
- **CLI:** Built via `bun build cli.ts --target=bun --outfile=../agent`.

## Directory Structure

```
multi-agent-engine/
  agents/
    personas/        # Agent persona markdown (frontmatter + system prompt)
    expertise/       # Deep knowledge files loaded per-agent
    skills/          # Reusable skill definitions
    teams/
      teams.yaml     # Team structure, members, model assignments
      chains.yaml    # Multi-step workflow definitions
  configs/
    model-routing.yaml       # Tier defaults, aliases, cross-model pairs, budgets
    damage-control-rules.yaml  # Safety rules and guardrails
  dashboard/
    main.go          # Go server with SSE events
    templates/       # templ templates (HTMX + Alpine.js)
    seed-test.sh     # Test data seeder
  engine/
    cli.ts           # CLI entry point
    orchestrator.ts  # Core orchestration logic
    config.ts        # Config loader (YAML parsing)
    types.ts         # All TypeScript types
    security.ts      # Security checks (advisory only, not enforced by adapters)
    event-emitter.ts # SSE event system
    adapters/        # Platform adapters (claude-code, codex, pi, echo)
  prompts/           # Reusable prompt workflows (plan-build-review, scout, etc.)
  justfile           # Task runner commands
```

## Common Tasks

| Task | Command |
|------|---------|
| Run tests | `just test` (or `cd engine && bun test`) |
| Type check | `just check` (or `cd engine && bunx tsc --noEmit`) |
| Build CLI binary | `just build` |
| Build dashboard | `just dashboard-build` |
| Start dashboard | `just dashboard` |
| Scaffold new agent | `just new-agent <name> [role] [team] [model]` |

## Adding a New Agent

Run `just new-agent <name> <role> <team> <model>` to scaffold persona and expertise files. Then:

1. Edit `agents/personas/<name>.md` -- set frontmatter (name, model, expertise path, skills, tools, domain)
2. Edit `agents/expertise/<name>.md` -- write the agent's deep knowledge
3. Add the agent to the appropriate team in `agents/teams/teams.yaml`

## Adding a New Chain

Edit `agents/teams/chains.yaml`. Each chain has:

- `description` -- one-line purpose
- `steps` -- ordered list of team/agent assignments with `till_done` criteria
- Optional: `parallel` blocks, `on_feedback` retry logic

## Key Files

- `engine/orchestrator.ts` -- core loop: parse chain, delegate to teams, check till_done
- `engine/types.ts` -- all interfaces (PersonaConfig, TeamConfig, Chain, SessionState, etc.)
- `engine/security.ts` -- security checks (advisory only; not enforced by adapters — see comment block in file)
- `configs/model-routing.yaml` -- model tiers, aliases, cross-model pairs, budget limits
- `agents/teams/teams.yaml` -- team structure with all agents and their assignments
