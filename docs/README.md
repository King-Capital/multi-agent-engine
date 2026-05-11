# Multi-Agent Engine (MAE) -- Getting Started

MAE is a multi-agent orchestration engine that coordinates teams of AI agents to plan, build, review, and validate software. You define tasks in natural language, and MAE routes them through configurable chains of agent teams -- planners, engineers, reviewers, security auditors -- each with their own persona, model, and domain constraints.

## Installation

Build the CLI from source and install it:

```bash
cd multi-agent-engine/
bun install
bun build engine/cli.ts --target=bun --outfile=./agent
cp agent ~/.local/bin/mae
```

Or use the justfile:

```bash
just build
cp agent ~/.local/bin/mae
```

Verify the installation:

```bash
mae version
```

```
MAE v0.2.67
Bun v1.2.x
Dashboard: http://localhost:8400
Adapters:  3 registered
Chains:    14 configured
```

## Quick Start

### 1. Set up your environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

At minimum, you need:

```bash
# LLM gateway (LiteLLM, OpenRouter, or any OpenAI-compatible proxy)
MAE_LLM_GATEWAY_URL="http://your-llm-proxy:4000"
MAE_LLM_GATEWAY_KEY="sk-your-key"

# Dashboard
MAE_DASHBOARD_URL="http://your-dashboard-host:8400"
```

See [configuration.md](configuration.md) for the full list of environment variables.

### 2. Run a task with the echo adapter (no real agents)

The echo adapter simulates agent work without calling any LLM. Use it to verify your setup:

```bash
mae task "Add input validation to the API" --dry-run
```

```
[cli] Auto-selected chain: plan-build-review (confidence: 0.92) -- Full development workflow
[cli] Using adapter: echo

Session abc123 completed. Cost: $0.000
```

### 3. Run a real task with the Pi adapter

With the Pi adapter configured (requires a running Pi agent), run a real task:

```bash
mae task "Fix the authentication bug in login.ts"
```

MAE will:
1. Auto-classify the task and select a chain (e.g., `build-verify`)
2. Dispatch agents through each chain step (planning, engineering, validation)
3. Print the session ID, status, and cost when complete

### 4. Choose a specific chain

Override auto-classification when you know what workflow you want:

```bash
mae task "Review the auth module for security vulnerabilities" --chain review-only
```

Or use the `chain` command directly:

```bash
mae chain plan-build-review "Add rate limiting to all API endpoints"
```

### 5. Inspect results

List recent sessions and their traces:

```bash
mae traces
```

Score a session to see how it performed:

```bash
mae score <session-id>
```

## Dashboard

The MAE dashboard is a React SPA that shows real-time session progress, agent activity, and team coordination. Access it at your configured `MAE_DASHBOARD_URL` (default: `http://localhost:8400`).

Check dashboard connectivity:

```bash
mae health
```

## What's Next

- [commands.md](commands.md) -- Full reference for every CLI command
- [concepts.md](concepts.md) -- How sessions, chains, teams, and the Ralph loop work
- [observability.md](observability.md) -- Logging, traces, Langfuse, and the dashboard
- [configuration.md](configuration.md) -- All config files and environment variables
