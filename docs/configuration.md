# Configuration Reference

MAE is configured through environment variables (`.env` file), YAML config files, and agent persona files.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MAE_LLM_GATEWAY_URL` | Yes | -- | LiteLLM, OpenRouter, or any OpenAI-compatible proxy URL |
| `MAE_LLM_GATEWAY_KEY` | Yes | -- | API key for the LLM gateway |
| `MAE_DASHBOARD_URL` | No | `http://localhost:8400` | Dashboard URL for session management and events |
| `MAE_API_TOKEN` | No | -- | Bearer token for authenticated dashboard API calls |
| `MAE_LOCAL` | No | `0` | Set to `1` to force localhost dashboard |
| `MAE_DEFAULT_ADAPTER` | No | auto-detect | Default adapter: `pi`, `a2a`, `echo` |
| `MAE_ROOT` | No | repo root | Override engine root directory |

### Database

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | -- | PostgreSQL connection string for session persistence |
| `DASHBOARD_PORT` | No | `8400` | Port for the dashboard API server |
| `CORS_ORIGINS` | No | -- | Comma-separated allowed CORS origins |

### LLM Provider Keys

If not using a gateway, set provider keys directly:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Direct Anthropic API key |
| `OPENAI_API_KEY` | Direct OpenAI API key |

Legacy gateway aliases (still supported):

| Variable | Maps to |
|----------|---------|
| `LITELLM_URL` | `MAE_LLM_GATEWAY_URL` |
| `LITELLM_KEY` | `MAE_LLM_GATEWAY_KEY` |
| `LITELLM_API_KEY` | `MAE_LLM_GATEWAY_KEY` |

### A2A (Agent-to-Agent)

| Variable | Description |
|----------|-------------|
| `MAE_A2A_URL` | Default A2A agent endpoint URL |
| `MAE_A2A_TOKEN` | Bearer token for A2A authentication |

### Langfuse

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LANGFUSE_PUBLIC_KEY` | For Langfuse | -- | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | For Langfuse | -- | Langfuse secret key |
| `LANGFUSE_HOST` | No | `http://localhost:3000` | Langfuse server URL |

Langfuse is enabled automatically when both keys are set. When not set, it is silently disabled.

### Logging and Traces

| Variable | Default | Description |
|----------|---------|-------------|
| `MAE_LOG_LEVEL` | `INFO` | Minimum log level: `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL` |
| `MAE_TRACE_DIR` | `~/.mae/traces/` | Directory for JSONL trace files |

### Sandbox Pool (Proxmox)

| Variable | Description |
|----------|-------------|
| `PVE_API` | Proxmox VE API URL (e.g., `https://proxmox:8006/api2/json`) |
| `PVE_TOKEN` | Proxmox API token |
| `PVE_NODE` | Proxmox node name |
| `MAE_SANDBOX_SUBNET` | Subnet for sandbox IPs (e.g., `10.0.0`) |
| `MAE_SANDBOX_HOST_OFFSET` | First host octet for sandbox IPs |
| `MAE_SANDBOX_GATEWAY` | Gateway IP for sandbox network |

---

## Model Routing (configs/model-routing.yaml)

Controls which models are used for which roles, how they are aliased, and budget limits.

### Tiers

Tiers group models by capability level. Each tier has a default model and a list of options:

```yaml
tiers:
  high:
    description: Orchestrators, leads, deep analysis, complex reasoning
    default: opus
    default_thinking: high
    context: 1000000
    options:
      - model: opus
        thinking: high
      - model: gemini-3.1-pro
        thinking: high
      - model: gpt-5.5
        thinking: high

  medium:
    description: Builders, workers, implementation, standard tasks
    default: sonnet
    default_thinking: medium
    context: 1000000
    options:
      - model: sonnet
        thinking: medium
      - model: gpt-5.5
        thinking: medium

  fast:
    description: Scouts, triage, quick exploration, cheap passes
    default: sonnet
    default_thinking: off
    context: 200000
    options:
      - model: sonnet
        thinking: off
```

### Aliases

Aliases map friendly names to model identifiers. These are the names you use in persona files and `--model` flags:

```yaml
aliases:
  quality: opus        # Claude Opus 4.6 -- max intelligence
  main: sonnet         # Claude Sonnet 4.6 -- balanced worker
  fast: sonnet         # Sonnet with no thinking -- speed optimized
  pro: gpt-5.5         # GPT 5.5 via configured LLM gateway -- cross-model partner
  gpt: gpt-5.5
  gpt-mini: gpt-5.4
```

### Role Defaults

Maps agent roles to tiers and thinking levels:

```yaml
roleDefaults:
  orchestrator:
    tier: high
    thinking: high
  lead:
    tier: high
    thinking: high
  sr:
    tier: high
    thinking: high
  worker:
    tier: medium
    thinking: medium
  scout:
    tier: fast
    thinking: off
```

### Cross-Model Pairs

Defines builder-verifier pairings that use different model families for redundancy:

```yaml
crossModelPairs:
  - builder: opus
    verifier: gpt-5.5
  - builder: gpt-5.5
    verifier: opus
  - builder: sonnet
    verifier: gpt-5.5
  - builder: opus
    verifier: gemini-3.1-pro
```

### Budgets

Cost guardrails per session and per agent:

```yaml
budgets:
  max_per_session_usd: 50    # Hard limit per session
  warn_at_usd: 25            # Warning threshold
  max_per_agent_usd: 15      # Hard limit per individual agent
  max_total_tokens: 10000000  # Token cap
  budget_action: pause        # What to do when limit hit: pause or error
```

### Concurrency

Controls parallel execution limits:

```yaml
concurrency:
  max_concurrent_agents: 10   # Max agents running at once across all teams
  max_concurrent_per_team: 5  # Max agents running in a single team
```

---

## Chains (agents/teams/chains.yaml)

Defines multi-step workflows. Each chain has a name, description, and a list of steps.

### Step Types

**Team step** -- delegates to a team:

```yaml
- team: Engineering
  till_done:
    - "All code changes implemented"
    - "Tests pass"
```

**Agent step** -- delegates to a single agent:

```yaml
- agent: Scout
  till_done:
    - "Codebase mapped"
```

**Parallel step** -- runs multiple teams simultaneously:

```yaml
- parallel:
    - team: Red Team
    - team: Blue Team
  till_done:
    - "Both perspectives covered"
```

**Deterministic step** -- runs a shell command:

```yaml
- deterministic:
    command: "bun tsc --noEmit 2>&1"
    label: "Type check verification"
    on_failure: loop
    max_retries: 1
```

### till_done Criteria

Each step has `till_done` criteria that must be satisfied before the chain moves forward. These can be:

**Simple text** -- the orchestrator judges whether the criterion is met:

```yaml
till_done:
  - "Implementation plan produced with files and risks"
```

**Output match** -- verifies agent output contains a specific pattern:

```yaml
till_done:
  - text: "Code reviewed -- grade assigned"
    type: output_match
    verify: "GRADE:\\s*(PASS|FEEDBACK|FAILED)"
```

### Feedback Loops

Steps can define what happens when validation fails:

```yaml
on_feedback:
  retry_team: Engineering    # Send back to this team
  max_attempts: 3            # Maximum retry attempts
  escalate_to: user          # Escalate to user after max attempts
```

---

## Teams (agents/teams/teams.yaml)

Defines team structure, members, and model assignments.

### Team Structure

```yaml
teams:
  - team-name: Engineering
    team-color: "#00d4ff"
    consult-when: >
      Writing code, implementing features, fixing bugs, building
      infrastructure, creating new files, modifying existing code.
    lead:
      name: Engineering Lead
      path: agents/personas/planner.md
      model: quality
      color: "#00d4ff"
    members:
      - name: Backend Engineer
        path: agents/personas/backend-engineer.md
        model: main
        color: "#00d4ff"
        consult-when: >
          APIs, data layer, auth flows, database queries.
      - name: Frontend Engineer
        path: agents/personas/frontend-engineer.md
        model: main
        color: "#00b4d8"
        consult-when: >
          UI components, React, CSS, accessibility.
```

### Key Fields

| Field | Description |
|-------|-------------|
| `team-name` | Display name for the team |
| `team-color` | Hex color for dashboard visualization |
| `consult-when` | Description of when to use this team (used by auto-classification) |
| `lead` | The team lead agent (coordinates workers, reviews output) |
| `members` | List of worker agents with their personas and models |

### Orchestrator

A single orchestrator is defined at the top of the file:

```yaml
orchestrator:
  name: Orchestrator
  path: agents/personas/orchestrator.md
  model: quality
  color: "#36f9f6"
```

The orchestrator coordinates across teams and makes high-level decisions about task routing and escalation.

---

## Persona Files (agents/personas/*.md)

See [concepts.md](concepts.md#personas) for the full structure. Key frontmatter fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Agent display name |
| `model` | string | Model alias from model-routing.yaml (`quality`, `main`, `fast`, `pro`) |
| `expertise` | string | Path to auto-maintained expertise file |
| `max_expertise_lines` | number | Max lines loaded from expertise |
| `skills` | list | Skill files the agent loads (path + use-when) |
| `tools` | list | Available tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `glob`, `delegate` |
| `domain.read` | list of globs | Files the agent can read |
| `domain.write` | list of globs | Files the agent can create/modify |
| `domain.update` | list of globs | Files the agent can update (typically their own expertise) |
| `domain.delete` | list of globs | Files the agent can delete (usually empty) |

### Interactive Configuration

Use the interactive TUI to browse and modify configuration:

```bash
mae config          # Interactive config TUI
mae config show     # Show current config summary
mae config export   # Export full config as JSON
mae config discover # Probe all configured models via LiteLLM
```
