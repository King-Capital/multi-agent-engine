# Command Reference

All commands follow the pattern `mae <command> [options]`. Run `mae <command> --help` for built-in help on any command.

---

## task

Run a task with automatic chain selection. MAE uses an LLM to classify your goal and pick the best chain, or you can override with `--chain`.

**Usage:**

```bash
mae task <task-description> [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--chain <name>` | Use a specific chain instead of auto-classification |
| `--adapter <name>` | Use a specific adapter (`pi`, `a2a`, `echo`) |
| `--dry-run` | Use the echo adapter for testing |
| `--cwd <path>` | Set the working directory for agents |

**Examples:**

```bash
# Auto-classified -- MAE picks the right chain
mae task "Add rate limiting to API endpoints"

# Explicit chain
mae task "Review auth module for security" --chain review-only

# Test without real agents
mae task "Add unit tests for budget module" --dry-run
```

**Output:**

```
[cli] Auto-selected chain: plan-build-review (confidence: 0.92) -- Full development workflow
[cli] Using adapter: pi

Session 2dbc90f5 completed. Cost: $1.234
```

When confidence is below 0.8, MAE warns you and defaults to `plan-build-review`:

```
[cli] Suggested chain: build-verify (confidence: 0.65) -- Low confidence
[cli] Low confidence -- using default: plan-build-review. Override with --chain <name>
```

---

## run

Run a named prompt workflow. Prompts are markdown files in the `prompts/` directory.

**Usage:**

```bash
mae run <prompt-name> [args...]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--adapter <name>` | Use a specific adapter |
| `--dry-run` | Use the echo adapter |
| `--cwd <path>` | Working directory for agents |

**Available prompts:** `plan-build-review`, `review`, `scout`, `swarm-review`, and others in the `prompts/` directory.

**Examples:**

```bash
mae run plan-build-review "Add input validation to auth"
mae run review "git diff HEAD~1"
mae run swarm-review "Review engine/ for bugs"
mae run scout "engine/"
```

If you want to run a configured chain, use `mae chain <chain-name> <task-description>` instead. `mae run` intentionally targets prompt workflows only.

---

## chain

Run a named chain directly. Unlike `task`, this skips auto-classification.

**Usage:**

```bash
mae chain <chain-name> <task-description>
```

**Options:**

| Flag | Description |
|------|-------------|
| `--adapter <name>` | Use a specific adapter |
| `--dry-run` | Use the echo adapter |
| `--cwd <path>` | Working directory for agents |

**Available chains:** See [concepts.md](concepts.md#chains) for the full list, or run `mae chain --help` to see all chains with their step counts and descriptions.

**Examples:**

```bash
mae chain build-verify "Fix the login bug"
mae chain review-only "Review auth module"
mae chain plan-build-review "Add caching layer"
mae chain swarm-review "Full review of engine/"
```

**Output:**

```
Session 8fa2c1b3 completed. Cost: $2.456
```

---

## setup qmd

Register the installed MAE repo as a qmd collection so validation and review agents can use indexed repo search before exploratory file walking.

**Usage:**

```bash
mae setup qmd [--name <collection>] [--embed]
```

**Examples:**

```bash
mae setup qmd
mae setup qmd --embed
mae setup qmd --name multi-agent-engine --embed
```

Without `--embed`, qmd keyword search is available after indexing. Add `--embed` when semantic `qmd vsearch`/`qmd query` should work.

---

## traces

List recent trace files or inspect a specific trace.

**Usage:**

```bash
mae traces              # List the 10 most recent traces
mae traces <id>         # Show summary of a specific trace
```

**Listing traces:**

```bash
mae traces
```

```
Recent traces (~/.mae/traces/):

Session ID                               Goal                                     Status
------------------------------------------------------------------------------------------
2dbc90f5-abc1-...                        Add rate limiting to API                  completed
8fa2c1b3-def4-...                        Fix auth bug in login.ts                  completed
```

**Inspecting a trace:**

```bash
mae traces 2dbc90f5
```

```
Trace: 2dbc90f5-abc1-...
Goal: Add rate limiting to API endpoints
Events: 47  |  Duration: 3.2m  |  Cost: $1.234

Event breakdown:
  agent.start              8
  agent.end                8
  chain.step.start         3
  chain.step.end           3
  tool.call                12
  log                      13
```

Partial session IDs work -- MAE matches the prefix. If the prefix is ambiguous, it lists all matches.

Traces are stored as JSONL files in `~/.mae/traces/` (or the path set by `MAE_TRACE_DIR`).

---

## score

Score a session trace with five deterministic checks.

**Usage:**

```bash
mae score <session_id>
```

**Checks performed:**

| Check | What it verifies |
|-------|-----------------|
| `session_completed` | Did the session reach `completed` status? |
| `all_steps_executed` | Were all chain steps started and finished? |
| `no_agent_failures` | Did any agents produce errors? |
| `no_error_logs` | Were there any ERROR or CRITICAL log events? |
| `cost_reasonable` | Was the total cost under $5.00? |

**Output:**

```
Session: 2dbc90f5
Goal: Add rate limiting to API endpoints
Overall: PASS

Check                    Result   Details
----------------------------------------------------------------------
session_completed        PASS
all_steps_executed       PASS
no_agent_failures        PASS
no_error_logs            PASS
cost_reasonable          PASS

Fingerprint:
  Tools:   read -> edit -> bash -> read -> edit
  Agents:  5
  Teams:   Planning -> Engineering -> Validation
  Steps:   3
  Errors:  0
```

The overall result is `PASS` (all checks pass), `PARTIAL` (session completed but some checks failed), or `FAIL` (session did not complete).

---

## compare

Compare the behavioral fingerprints of two sessions.

**Usage:**

```bash
mae compare <session_id_1> <session_id_2>
```

**Output:**

```
Comparing:
  A: 2dbc90f5 -- Add rate limiting to API
  B: 8fa2c1b3 -- Add rate limiting to API (replay)

Similarity: 87.5%

Differences:
  - agentCount: 5 vs 6
  - toolSequence: 12 tools vs 15 tools (78% similar)
```

Similarity is a 0-100% score based on comparing agent counts, step counts, error counts, tool call sequences, team sequences, and status transitions. See [concepts.md](concepts.md#behavioral-fingerprinting) for how fingerprinting works.

---

## replay

Re-run a past session's goal and compare the new trace to the old one.

**Usage:**

```bash
mae replay <session_id>
```

**Options:**

| Flag | Description |
|------|-------------|
| `--adapter <name>` | Use a specific adapter |
| `--dry-run` | Use the echo adapter |

**Output:**

```
Replaying session 2dbc90f5
Goal: Add rate limiting to API endpoints
Chain: plan-build-review
Running...

New session: 9c4e5a2f (completed)
Cost: $1.456

Fingerprint similarity: 82.3%
Differences:
  - agentCount: 5 vs 6
  - toolSequence: 12 tools vs 14 tools (75% similar)
```

Replay extracts the original goal and chain from the old trace, runs them again through the engine, then compares behavioral fingerprints. Because LLM output is non-deterministic, you compare behavior patterns (what tools were called, how many agents ran, what teams were used) rather than exact output.

---

## validate-chain

Preview a configured chain without spawning agents, starting adapters, writing traces, or spending model tokens. This reads `agents/teams/chains.yaml`, `agents/teams/teams.yaml`, persona domains, and model routing to show what would run.

**Usage:**

```bash
mae validate-chain <chain-name> [goal]
mae validate-chain "goal text"
mae validate-chain <chain-name> --json
```

**Examples:**

```bash
# Show the configured standard swarm: Arch coordinator plus SME squads
mae validate-chain standard-swarm

# Suggest a chain from goal text using local config only
mae validate-chain "Design dashboard UI review"

# Machine-readable report for scripts or CI
mae validate-chain plan-build-review "Add cost summary to session detail" --json
```

**Output:**

```
Chain: standard-swarm (2 steps)
Description: 5-squad parallel review swarm: orchestrator assigns paths, leads spin out full workforce immediately

Step 1: Architecture Coordination
  Teams: Architecture Coordination
  Lead: Arch Coordinator (opus, thinking=high) - domain: expertise/planner.md
  Till Done:
    - Arch coordinator produced the SME squad coverage plan [output_match] (SWARM_COORDINATION_READY)

Step 2: Parallel teams
  Teams: Correctness Squad, Adversarial Squad, Quality Squad, Security Squad, Domain Squad
  Leads:
    - Correctness Lead (opus, thinking=high) - domain: **/*
    - Adversarial Lead (opus, thinking=high) - domain: **/*
    - Quality Lead (opus, thinking=high) - domain: **/*
    - Security Lead (opus, thinking=high) - domain: **/*
    - Domain Lead (opus, thinking=high) - domain: expertise/planner.md

Summary: 2 steps, 0 deterministic checks, 32 agent spawns (6 leads + 26 workers)
Models: 15 sonnet, 13 opus, 4 gpt-5.5
Estimated cost: $6.69-$26.77 (config-only estimate)
```

`swarm-review` is the canonical lean PR/code review swarm. Its five parallel review teams set `lead_only: true`, so MAE spawns only the Correctness, Adversarial, Quality, Security, and Domain leads instead of each team's full worker set.

When the first argument is not a configured chain name, MAE treats the arguments as goal text and picks the closest configured chain with deterministic local keyword matching. Use `mae task` when you want live LLM classification.

---

## validate-cert

Validate certification evidence from an existing trace file. This is deterministic: it checks trace events and artifacts and emits a machine-readable `VALIDATION_CONTRACT`; LLM commentary is not authoritative.

**Usage:**

```bash
mae validate-cert <trace-file> [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--trace-dir <dir>` | Trace/artifacts directory, defaults to the trace file parent |
| `--work-dir <dir>` | Certification fixture workdir, defaults to the current directory |
| `--repo-root <dir>` | Repository root used for source-read checks |
| `--expected <fixture>` | Expected fixture: `clean`, `seeded`, or `failing` |
| `--live-pi` | Enable live Pi checks such as worker-spawn and repo-source-read enforcement |
| `--strict-spawn` | Require every worker spawn to have valid `SPAWN_DECISION` evidence |
| `--json` | Emit the validation contract as JSON |

**Examples:**

```bash
mae validate-cert ~/.mae/traces/abc123.jsonl
mae validate-cert ./trace.jsonl --expected clean --live-pi
mae validate-cert ./trace.jsonl --strict-spawn --json
```

Strict spawn validation is part of Standard Swarm v2 Phase 4. A valid worker spawn must have a prior `spawn_decision` dashboard event, backed by a `spawn.decision` JSONL trace entry, with scoped paths, allowed tools, forbidden paths, isolated bus policy, expected output schema, and timeout. Runtime strict mode can also be enabled from chain config with `strict_spawn: true`.

---

## golden

Manage golden traces -- verified-good (or verified-bad) session runs used as baselines for regression testing.

**Usage:**

```bash
mae golden add <session_id> [options]    # Mark a trace as golden
mae golden list                          # List all golden traces
```

**Options for `add`:**

| Flag | Description |
|------|-------------|
| `--verdict <pass\|fail>` | Mark as good (`pass`, default) or bad (`fail`) reference |
| `--notes "..."` | Add a note explaining why this trace is golden |

**Examples:**

```bash
# Mark a successful run as a golden reference
mae golden add 2dbc90f5 --notes "Clean plan-build-review with zero errors"

# Mark a bad run for regression detection
mae golden add 8fa2c1b3 --verdict fail --notes "Agent loop caused $12 cost overrun"
```

**Listing golden traces:**

```bash
mae golden list
```

```
Session ID                               Verdict  Date         Goal
------------------------------------------------------------------------------------------
2dbc90f5-abc1-...                        pass     2026-05-10   Add rate limiting to API
8fa2c1b3-def4-...                        fail     2026-05-10   Fix auth bug

Notes:
  2dbc90f5: Clean plan-build-review with zero errors
  8fa2c1b3: Agent loop caused $12 cost overrun
```

Golden traces are stored in `~/.mae/traces/golden.json` and are used by the Ralph loop to prevent regressions.

---

## ralph

Run the self-improvement loop. Analyzes recent traces, identifies weak patterns, proposes persona/config mutations, and accepts only changes that do not regress scores.

**Usage:**

```bash
mae ralph [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--iterations <N>` | Maximum number of mutations to try (default: 5) |
| `--dry-run` | Analyze and propose mutations without writing changes |
| `--model <alias>` | Model to use for evaluator/evolver (default: `quality`) |

**Examples:**

```bash
# Full run with defaults
mae ralph

# Preview what would change without modifying anything
mae ralph --dry-run

# Run more iterations with a specific model
mae ralph --iterations 10 --model quality
```

**Output:**

```
Ralph loop complete:
  Iterations: 5
  Accepted:   2
  Rejected:   3

Mutations:
  [+] backend-engineer: Add explicit error boundary handling to Rules section
      Score: 0.80 -> 0.80
  [+] reviewer: Strengthen P0 classification criteria in Domain Knowledge
      Score: 0.80 -> 0.80
  [-] scout: Remove bash tool (caused timeout in trace abc123)
      Score: 0.80 -> 0.00
```

`[+]` means the mutation was accepted (score did not regress). `[-]` means it was rejected. Accepted mutations are automatically git-committed for easy rollback.

See [concepts.md](concepts.md#the-ralph-loop) for a detailed explanation of the three-population architecture.

---

## update

Pull the latest code from GitHub, rebuild the CLI binary, and install it.

**Usage:**

```bash
mae update
```

**Output:**

```
[mae] Pulling latest from GitHub...
[mae] Installing dependencies...
[mae] Building...
[mae] Updated to v0.2.67 -- installed at ~/.local/bin/mae
```

This runs `git pull origin main`, `bun install`, `bun build`, then copies the binary to `~/.local/bin/mae`.

---

## info

Show a detailed overview of engine configuration: chains, adapters, model routing, and dashboard status.

**Usage:**

```bash
mae info
```

**Output:**

```
==================================================
  Multi-Agent Engine v0.2.67
==================================================
  Bun: v1.2.x  |  Dashboard: http://localhost:8400

--------------------------------------------------
  CHAINS
--------------------------------------------------
  plan-build-review           4 steps  Full development workflow: plan, implement, validate
  build-verify                3 steps  Builder-verifier loop with 3-attempt escalation
  review-only                 1 steps  Full parallel review: red team + blue team + validation
  ...
  Total: 14 chains

--------------------------------------------------
  ADAPTERS
--------------------------------------------------
  * echo                 available
  * pi                   available
  * a2a                  not available

--------------------------------------------------
  MODEL ROUTING
--------------------------------------------------
  high       default: opus                         (3 options)
             Orchestrators, leads, deep analysis, complex reasoning
  medium     default: sonnet                       (4 options)
             Builders, workers, implementation, standard tasks
  fast       default: sonnet                       (2 options)
             Scouts, triage, quick exploration, cheap passes

  Aliases:
    quality      -> opus
    main         -> sonnet
    fast         -> sonnet
    pro          -> gpt-5.5

  Budgets:
    Max/session: 50  |  Warn at: 25  |  Max/agent: 15

--------------------------------------------------
  DASHBOARD
--------------------------------------------------
  * Connected (http://localhost:8400)

==================================================
```

---

## version

Print version information in a compact format.

**Usage:**

```bash
mae version
```

**Output:**

```
MAE v0.2.67
Bun v1.2.x
Dashboard: http://localhost:8400
Adapters:  3 registered
Chains:    14 configured
```

---

## adapters

List all registered adapters and their availability.

**Usage:**

```bash
mae adapters
```

**Output:**

```
Available adapters:
  * echo (available)
  * pi (available)
  * a2a (not installed/configured)
```

---

## new-agent

Scaffold a new agent persona with default configuration.

**Usage:**

```bash
mae new-agent <name> [role] [team] [model]
```

**Arguments:**

| Argument | Default | Description |
|----------|---------|-------------|
| `name` | (required) | Agent name |
| `role` | `worker` | One of `orchestrator`, `lead`, `worker` |
| `team` | `Engineering` | Team to add the agent to |
| `model` | `main` (worker) / `quality` (lead/orch) | Model alias |

**Example:**

```bash
mae new-agent "Database Expert" worker Engineering main
```

```
Created: agents/personas/database-expert.md
Created: agents/expertise/database-expert.md

Next: Add this agent to agents/teams/teams.yaml under the Engineering team.
Tip: Edit the persona file to customize the Purpose and Rules sections.
```

This creates a persona file with YAML frontmatter (name, model, skills, tools, domain constraints) and a starter system prompt, plus an empty expertise file.

---

## new-team

Create a new agent team interactively or from a template.

**Usage:**

```bash
mae new-team                     # Interactive wizard (TUI)
mae new-team --template <name>   # Create from template
```

**Templates:** `trading`, `devops`, `frontend`, `research`

The wizard walks you through team name, color, members, roles, and optionally generates a starter chain. All persona and expertise files are scaffolded automatically.

---

## learn

Build agent expertise from reference sources.

**Usage:**

```bash
mae learn --from <path>       --agent <name>   # Learn from a codebase
mae learn --from <url>        --agent <name>   # Learn from a URL/document
mae learn --from-agent <src>  --agent <name>   # Copy structure from existing agent
```

Scans the source, extracts patterns and conventions, and generates structured expertise in `agents/expertise/<name>.md`.

---

## expert

Start an interactive expert session on a codebase.

**Usage:**

```bash
mae expert <path>                 # Drop into expert session
mae expert <path> --agent <name>  # Use existing agent's expertise
```

Auto-learns the codebase if no expertise exists, then starts an interactive REPL where you can ask questions and get implementations from an agent that deeply understands the code.

---

## validate-agent

Test and grade an agent's expertise quality.

**Usage:**

```bash
mae validate-agent <name>
```

Runs the agent on a test prompt, grades specificity, depth, and actionability, and suggests improvements to the expertise file.

---

## health

Run a comprehensive engine health check.

**Usage:**

```bash
mae health           # Human-readable report
mae health --json    # Machine-readable JSON
```

**Checks performed:**

- Engine version and Bun version
- Adapter availability (echo, pi, a2a)
- Trace directory exists, is writable, and has recent traces
- Dashboard connectivity and version
- Langfuse connectivity (if configured)

**Output:**

```
==================================================
  * Engine Health: HEALTHY
==================================================
  Version: v0.2.67  |  Bun: v1.2.x
  Checked: 2026-05-10T14:30:00.000Z

--------------------------------------------------
  ADAPTERS
--------------------------------------------------
  * echo                 available
  * pi                   available
  * a2a                  not available

--------------------------------------------------
  TRACE RECORDING
--------------------------------------------------
  Directory: ~/.mae/traces
  * Exists: yes
  * Writable: yes
  Recent traces (24h): 5

--------------------------------------------------
  DASHBOARD
--------------------------------------------------
  * http://localhost:8400 -- connected

--------------------------------------------------
  LANGFUSE
--------------------------------------------------
  * http://localhost:3000 -- connected

==================================================
```

Overall status is `HEALTHY` (all core systems up), `DEGRADED` (traces unwritable or dashboard unreachable), or `UNHEALTHY` (no adapters available). The command exits with code 1 when unhealthy, making it usable in scripts and CI.
