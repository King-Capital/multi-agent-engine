# Contributing to Multi-Agent Engine (MAE)

Thanks for your interest in contributing to MAE! This document covers everything you need to get started.

## How to Contribute

1. Check existing [issues](../../issues) for something to work on, or open a new one
2. Fork the repo and create a feature branch
3. Make your changes following the guidelines below
4. Open a pull request

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) (latest) -- TypeScript runtime for the engine
- [Go](https://go.dev/) 1.22+ -- for the dashboard
- [templ](https://templ.guide/) -- Go HTML templating (dashboard views)
- [just](https://github.com/casey/just) -- command runner (see `Justfile`)

### Install Dependencies

```bash
# Engine (TypeScript)
cd engine && bun install

# Dashboard (Go)
cd dashboard && go mod download

# Generate templ templates
templ generate
```

## Running Tests

```bash
# Engine unit tests
bun test

# Dashboard build check
cd dashboard && go build ./...

# Go vet (lint)
go vet ./...

# Smoke tests (end-to-end)
scripts/smoke-test.sh
```

## Branch Naming Conventions

Use prefixed branch names:

| Prefix | Use For |
|--------|---------|
| `feat/` | New features, capabilities, agents |
| `fix/` | Bug fixes, corrections |
| `docs/` | Documentation only changes |
| `refactor/` | Code restructuring without behavior change |
| `chore/` | Build, CI, dependency updates |

Examples:
- `feat/sandbox-pool-v6`
- `fix/stream-text-output`
- `docs/contributing-guide`

## PR Process

1. **Create a PR** against `main` with a clear title and description
2. **Reference the issue** (e.g., "Closes #42") in the PR body
3. **CI must pass** -- all checks green before merge
4. **Squash merge** -- keep `main` history clean with one commit per PR
5. PRs are auto-versioned on merge via the release workflow

## Code Style

| Component | Language | Location |
|-----------|----------|----------|
| Engine (orchestrator, CLI, adapters) | TypeScript | `engine/` |
| Dashboard (web UI, API) | Go + templ | `dashboard/` |
| Configuration (agents, chains, routing) | YAML | `configs/`, `agents/teams/` |
| Scripts & CI | Bash | `scripts/`, `.github/` |

General rules:
- TypeScript: use Bun APIs, no Node-specific imports
- Go: standard `gofmt`, no third-party linters required
- YAML: 2-space indent, comments for non-obvious fields

## Agent Development

Create a new agent using the `just` command:

```bash
just new-agent <name> [role] [team] [model]
```

**Parameters:**
- `name` -- agent identifier (e.g., `security-auditor`)
- `role` -- agent role, default `worker` (options: `worker`, `lead`, `reviewer`)
- `team` -- team assignment, default `Engineering`
- `model` -- model routing key, default `main`

Example:
```bash
just new-agent security-auditor reviewer Security main
```

Agents are defined in `configs/agent-teams.yaml`. After creation, configure the agent's system prompt and capabilities.

## Chain Development

Chains are reusable multi-agent workflows defined in `agents/teams/chains.yaml`.

To add a new chain:

1. Open `agents/teams/chains.yaml`
2. Add a new chain entry with the required fields:

```yaml
my-chain:
  description: "What this chain does"
  steps:
    - agent: planner
      action: plan
    - agent: builder
      action: build
    - agent: reviewer
      action: review
```

3. Test it with:
```bash
just chain my-chain "test task description"
```

4. For dry runs (echo adapter, no real LLM calls):
```bash
just dry "test task" --chain my-chain
```

## Questions?

Open an issue or reach out to the maintainers. We're happy to help.
