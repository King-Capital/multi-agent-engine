# Multi-Agent Engine

> All LAWs (#!/bin/bash, protected branches, stack prefs) enforced via ~/.claude/CLAUDE.md and hooks.


## Stack

- **Engine:** Bun + TypeScript. Use `bun` not `npm/yarn`. Use `bun:test` for tests.
- **Dashboard:** Go + React SPA (`dashboard-next/src/`). Legacy templ files in `dashboard/templates/` — don't use.
- **Config:** YAML files in `configs/` and `agents/teams/`.
- **CLI:** Built via `bun build engine/cli.ts --target=bun --outfile=./agent`. Installed at `~/.local/bin/mae`.
- **Observability:** Langfuse v3. Auto-connects when `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` are set. Host configured via `LANGFUSE_HOST` env var.

## Documentation Policy

Documentation is a source of truth for this repo. Any code, config, command, trace schema, validation, dashboard, workflow, or operator-facing behavior change must update the relevant docs in the same branch. Check `README.md`, `docs/`, `specs/`, `.planning/`, and nearby module READMEs before calling work complete. If implementation reality differs from a planning doc, update the doc and record intentional deviations in the appropriate `DECISIONS.md` or progress log.

## Directory Structure

```
multi-agent-engine/
  agents/
    personas/        # Agent persona markdown (frontmatter + system prompt) — 20 personas
    expertise/       # Deep knowledge files loaded per-agent
    skills/          # Reusable skill definitions
    teams/
      teams.yaml     # Team structure, members, model assignments
      chains.yaml    # Multi-step workflow definitions
  configs/
    model-routing.yaml  # Tier defaults, aliases, cross-model pairs, budgets
  dashboard/
    main.go          # Go API server (SSE events, PG persistence, auth)
  dashboard-next/
    src/             # React SPA — the active UI
  engine/
    cli.ts           # CLI entry point — all mae commands
    orchestrator.ts  # Session lifecycle, adapter management, steer commands
    chain-runner.ts  # Chain execution loop, till_done verification
    chain-validator.ts # Config-only chain preview, agent spawn and cost estimate
    team-execution.ts  # Decomposed team execution (7 exported sub-functions)
    worker-lifecycle.ts # Worker retry, Sr. agent spawning, lead review
    session-state.ts # Centralized status transition state machine
    config.ts        # Config loader (YAML parsing, caching with mtime)
    types.ts         # All TypeScript types
    logger.ts        # Structured JSONL logger with pluggable sinks
    langfuse-sink.ts # Langfuse trace ingestion sink
    trace-recorder.ts # Per-session JSONL trace files
    replay.ts        # Eval flywheel — scoring, fingerprinting, golden traces
    goal-classifier.ts # Auto-classify goals into chains via LLM
    ralph-loop.ts    # Self-improvement loop orchestrator
    ralph-evaluator.ts # Population B — analyzes traces, produces findings
    ralph-evolver.ts # Population C — proposes config mutations from findings
    llm-gateway.ts   # LiteLLM gateway client for standalone LLM calls
    budget.ts        # Budget enforcement with safe defaults on failure
    security.ts      # Input sanitization + URL validation (42 lines, no dead code)
    event-emitter.ts # Dashboard event system with HTTP retry + circuit breaker
    health.ts        # Health check — adapter, trace, dashboard, Langfuse probes
    tui-harness.ts   # tmux-backed CLI/TUI smoke test harness
    adapters/        # Platform adapters (pi, a2a, echo)
  specs/
    trace-schema.md  # JSONL trace schema — contract for Ralph loop
  .planning/         # Execution plans, deploy specs
  .reports/          # Audit reports, session wraps
  prompts/           # Reusable prompt workflows
  justfile           # Task runner commands
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `mae task "description"` | Run a task (auto-classifies chain, or use `--chain name`) |
| `mae chain <chain> "task"` | Run with explicit chain |
| `mae run <prompt> [args...]` | Run a reusable prompt workflow from `prompts/` |
| `mae traces` | List recent trace files |
| `mae traces <id>` | Show trace summary |
| `mae score <id>` | Score a session with deterministic checks |
| `mae compare <id1> <id2>` | Compare two session fingerprints |
| `mae replay <id>` | Re-run a session's goal and compare |
| `mae validate-chain <chain-or-goal>` | Preview configured chain teams, agents, checks, and cost |
| `mae golden add <id>` | Mark a trace as golden reference |
| `mae golden list` | List golden traces |
| `mae ralph` | Run self-improvement loop (default 5 iterations) |
| `mae ralph --dry-run` | Analyze and propose without writing changes |
| `mae ralph --iterations N` | Run N iterations |
| `mae ralph --model quality` | Use opus for analysis |
| `mae adapters` | List available adapters |
| `mae info` | Show engine config and status |
| `mae new-agent <name>` | Scaffold a new agent persona |
| `mae new-team` | Interactive team creation |
| `mae learn --from <path>` | Build agent expertise from codebase |
| `mae validate-agent <name>` | Test and grade agent quality |
| `mae expert <path>` | Interactive expert REPL |
| `mae health` | Engine health check (adapters, traces, dashboard, Langfuse) |
| `mae health --json` | Machine-readable JSON health output |

## Observability Stack

| Component | Location | Purpose |
|-----------|----------|---------|
| Structured Logger | `engine/logger.ts` | JSONL to stderr + pluggable sinks |
| Trace Recorder | `engine/trace-recorder.ts` | Per-session JSONL at `~/.mae/traces/` |
| Langfuse Sink | `engine/langfuse-sink.ts` | Sends traces to Langfuse for visualization |
| Langfuse | `LANGFUSE_HOST` env var | Trace UI, prompt versioning, evaluation, datasets |
| Replay System | `engine/replay.ts` | Session scoring, behavioral fingerprinting |
| Ralph Loop | `engine/ralph-loop.ts` | Overnight self-improvement via trace analysis |

### Langfuse Configuration

- **Models:** claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 (with pricing)
- **Scores:** session_completion, agent_grade, cost_efficiency, worker_success_rate, chain_step_completion
- **Prompts:** 20 agent personas registered with version tracking
- **Datasets:** mae-golden-sessions, mae-failure-cases, mae-prompt-experiments
- **Annotation Queues:** Session Review, Agent Quality, Failure Triage
- **Credentials:** Vaultwarden "Langfuse - MAE"

## Three-Population Architecture

```
Population A (Workers) — existing personas, execute tasks via Pi/CC/echo adapters
      ↓ produce traces
Population B (Evaluator) — ralph-evaluator.ts, analyzes traces, produces findings
      ↓ findings
Population C (Evolver) — ralph-evolver.ts, proposes config mutations
      ↓ mutations
Git Ratchet — test against golden traces, accept if improved, reject if regressed
```

No agent modifies its own config. Run `mae ralph` overnight.

## Key Files

- `engine/orchestrator.ts` — session lifecycle, adapter management, steer commands
- `engine/chain-runner.ts` — chain execution loop, till_done verification
- `engine/chain-validator.ts` — config-only chain previews for teams, agents, checks, and cost
- `engine/team-execution.ts` — decomposed into 7 sub-functions (prepareTeamStep → buildTeamResult)
- `engine/session-state.ts` — centralized status transitions (active → paused → completed/error)
- `engine/logger.ts` — all logging goes through this, no raw console.log
- `engine/security.ts` — input sanitization only (42 lines, enforcement delegated to Pi extensions)
- `specs/trace-schema.md` — the contract between traces and the Ralph loop
- `agents/teams/chains.yaml` — chain definitions (plan-build-review, swarm-review, etc.)
- `agents/teams/teams.yaml` — team structure with all agents

## Testing

Run with `bun test` or `just test`. Tmux smoke coverage is opt-in with `MAE_RUN_TMUX_TESTS=1 bun test engine/tui-harness.test.ts`.

Critical modules tested: team-execution (18), event-emitter (13), session-state (13), worker-lifecycle (6), replay (17), ralph-loop (25), logger (13), goal-classifier (8).

## Build & Install

```bash
just build                    # builds engine/cli.ts → ./agent
cp agent ~/.local/bin/mae     # install globally
mae info                      # verify
```
