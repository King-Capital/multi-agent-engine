# Multi-Agent Engine

Orchestration engine that coordinates teams of AI agents through structured chains -- plan, build, review, and swarm workflows with a real-time Go dashboard.

## Architecture

```
                          User / CLI
                              |
                         Orchestrator
                        (quality model)
                       /      |       \
                 Planning  Engineering  Validation
                   Lead       Lead        Lead
                    |          |           |
                  Scout     Builder    Reviewer
                                      Security
                                      Adversarial
                                      Correctness
                                      Quality

    Parallel teams (Engineering B, Validation B) use different
    model families for cross-model verification.

    Swarm mode splits into Red Team + Blue Team for
    adversarial vs. correctness review in parallel.

    Dashboard (Go/templ/HTMX) ------> SSE event stream
```

## Prerequisites

| Tool | Install |
|------|---------|
| [Bun](https://bun.sh) | See bun.sh for install instructions |
| [just](https://github.com/casey/just) | `brew install just` |
| [Go](https://go.dev) (1.22+) | `brew install go` |
| [templ](https://templ.guide) | `go install github.com/a-h/templ/cmd/templ@latest` |

## Quickstart

```bash
# Install engine dependencies
cd engine && bun install

# Build the CLI binary
just build

# Run a task (plan-build-review chain)
just task "add input validation to the signup handler"

# Dry run (echo adapter, no real agents)
just dry "refactor the auth module"

# Start the dashboard
just dashboard-build
just dashboard
```

## Justfile Commands

| Command | Description |
|---------|-------------|
| `just run <prompt> [args]` | Run a reusable prompt workflow |
| `just chain <name> [task]` | Run a named chain directly |
| `just task <description>` | Run plan-build-review (default workflow) |
| `just dry <description>` | Dry run with echo adapter |
| `just pbr <task>` | Plan, build, and review a task |
| `just review <diff>` | Review code changes |
| `just scout <target>` | Scout/explore a codebase area |
| `just parallel <task>` | Build with multiple models, pick best |
| `just swarm <target>` | Full swarm review (red + blue teams) |
| `just red-blue <target>` | Red team attacks, blue team validates |
| `just scout-swarm <target>` | Scout first, then swarm flagged areas |
| `just build-swarm <task>` | Build then swarm review the output |
| `just new-agent <name>` | Scaffold a new agent |
| `just adapters` | List available adapters |
| `just dashboard` | Start the dashboard server |
| `just dashboard-build` | Rebuild the dashboard binary |
| `just dashboard-seed` | Seed test data into the dashboard |
| `just test` | Run all tests |
| `just build` | Build the engine CLI as standalone binary |
| `just check` | Type check the engine |
| `just teams` | Show team configuration |
| `just chains` | Show available chains |
| `just prompts` | Show available prompts |
| `just persona <name>` | Show an agent's persona |
| `just expertise <name>` | Show an agent's expertise |
| `just rules` | Show damage-control rules |

## Agents

| Agent | Role | Model Tier |
|-------|------|------------|
| Orchestrator | Routes tasks to teams, synthesizes results | quality |
| Planning Lead | Produces implementation plans, assesses risks | quality |
| Scout | Fast codebase exploration, file discovery, triage | fast |
| Builder | Code implementation, file creation, builds and tests | main |
| Code Reviewer | Correctness review, quality checks, P0-P3 grading | quality |
| Security Reviewer | OWASP checks, injection, credential leaks, prompt injection | quality |
| Validation Lead | Coordinates review teams, final grade | quality |
| Adversarial Reviewer | Devil's advocate, assumption challenging, attack vectors | quality |
| Correctness Reviewer | Atomic claim verification, type safety, spec compliance | quality |
| Quality Reviewer | Maintainability, naming, structure, duplication, dead code | pro |

## Teams

| Team | Purpose | Lead Model |
|------|---------|------------|
| Planning | Codebase analysis, implementation plans, risk assessment | quality |
| Engineering | Code implementation, feature building, bug fixing | quality |
| Engineering B | Parallel implementation with different model family | pro |
| Validation | Code review, security review, QA testing | quality |
| Validation B | Parallel validation with cross-model verification | pro |
| Red Team | Adversarial review, security testing, attack surface analysis | quality |
| Blue Team | Correctness verification, quality review, maintainability | pro |

## Chains

| Chain | Description |
|-------|-------------|
| `plan-build-review` | Full development workflow: plan, implement, validate |
| `scout-then-plan` | Explore first, then produce a plan |
| `build-verify` | Builder-verifier loop with 3-attempt escalation |
| `parallel-build` | Same task, multiple model families, best result wins |
| `review-only` | Code review and security check on existing changes |
| `full-sdlc` | Complete SDLC: scout, plan, parallel build, parallel validate |
| `swarm-review` | Red team + blue team in parallel, orchestrator synthesizes |
| `red-blue` | Red team attacks, blue team defends -- competing perspectives |
| `scout-swarm` | Scout first, then swarm review flagged areas |
| `build-then-swarm` | Build with engineering, then swarm review the output |

## Tech Stack

| Component | Technology |
|-----------|------------|
| Engine | Bun / TypeScript |
| CLI | Bun-compiled standalone binary |
| Dashboard | Go 1.26 / chi router |
| Templates | templ (type-safe Go templates) |
| Dashboard UI | HTMX + Alpine.js + SSE |
| Config | YAML (teams, chains, model routing, damage control) |
| Adapters | Claude Code, Codex, Pi, Echo (dry-run) |
| Testing | bun:test |

## Model Routing

| Tier | Default Model | Thinking | Used By |
|------|---------------|----------|---------|
| high | opus-nocache | high | Orchestrators, leads, deep analysis |
| medium | sonnet-nocache | medium | Builders, workers, implementation |
| fast | sonnet-nocache | low | Scouts, triage, quick exploration |

Thinking levels: `off` < `minimal` < `low` < `medium` < `high` < `xhigh`

Cross-model pairs are configured in `configs/model-routing.yaml` to ensure builder and verifier always use different model families.

## Adapters

| Adapter | Description |
|---------|-------------|
| `claude-code` | Delegates to Claude Code CLI |
| `codex` | Delegates to OpenAI Codex CLI |
| `pi` | Delegates to Pi coding agent |
| `echo` | Dry-run adapter, prints what would happen |
