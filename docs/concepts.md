# Core Concepts

This document explains the key concepts in MAE. Read this if you want to understand how the system works before diving into commands or configuration.

---

## Sessions

A **session** is a single end-to-end execution of a task. When you run `mae task "Fix the login bug"`, MAE creates a session that tracks everything: which chain was selected, which teams ran, what each agent did, how much it cost, and whether it succeeded.

### Session Lifecycle

```
active  -->  paused  -->  active  -->  completed
                |                        |
                +------->  error  <------+
```

- **active** -- agents are currently working
- **paused** -- waiting for user input, budget approval, or escalation
- **completed** -- all chain steps finished successfully
- **error** -- an unrecoverable failure occurred

Every session gets a UUID. Use it to inspect traces (`mae traces <id>`), score results (`mae score <id>`), or replay the same goal (`mae replay <id>`).

### Session Management

```bash
mae session list                          # List all sessions
mae session close <id>                    # Mark a session as completed
mae session close <id> --status error     # Mark a session as errored
```

---

## Chains

A **chain** is a multi-step workflow that defines which teams run in what order. Chains are the backbone of MAE -- they turn a raw goal into structured execution.

### Available Chains

| Chain | Steps | Description |
|-------|-------|-------------|
| `plan-build-review` | 4 | Full dev workflow: plan, implement, type-check, validate |
| `build-verify` | 3 | Build then verify with a 3-attempt escalation loop |
| `review-only` | 1 | Red team + blue team + validation in parallel |
| `swarm-review` | 1 | Red team + blue team parallel review |
| `parallel-build` | 2 | Same task on two model families, best result wins |
| `full-sdlc` | 4 | Scout, plan, parallel build, parallel validate |
| `scout-then-plan` | 2 | Explore codebase first, then produce a plan |
| `design-review` | 3 | Scout UI, design improvements, validate |
| `design-build` | 4 | Design first, implement, type-check, validate |
| `standard-swarm` | 1 | 5-squad parallel review (correctness, adversarial, quality, security, domain) |
| `red-blue` | 2 | Red team attacks, blue team defends |
| `scout-swarm` | 2 | Scout first, then swarm review flagged areas |
| `build-then-swarm` | 4 | Plan, build, type-check, then red+blue review |

### How Chains Work

Each step in a chain specifies either a **team** or an individual **agent**, plus **till_done** criteria that must be satisfied before the step is complete.

```yaml
steps:
  - team: Planning
    till_done:
      - "Implementation plan produced with files, risks, and steps"
      - "All relevant files read and understood"
  - team: Engineering
    till_done:
      - "All code changes implemented per plan"
      - "Tests pass"
```

Steps can also be:
- **Parallel** -- multiple teams run simultaneously (e.g., Red Team and Blue Team)
- **Deterministic** -- a shell command like `bun tsc --noEmit` that gates the next step
- **Feedback loops** -- if validation fails, retry the Engineering team up to N times, then escalate to the user

### Auto-Classification

When you use `mae task`, MAE sends your goal to an LLM that classifies it into the best chain. If classification confidence is 0.8 or higher, it uses that chain automatically. Below 0.8, it defaults to `plan-build-review` and tells you. You can always override with `--chain`.

---

## Teams

A **team** is a group of agents with a lead and one or more workers. Teams are defined in `agents/teams/teams.yaml`.

### Team Structure

Every team has:
- **Lead** -- coordinates work, briefs workers, reviews their output. Uses a higher-tier model (typically `quality`).
- **Workers** -- execute specific tasks within their domain. Use a standard-tier model (typically `main`).
- **consult-when** -- a description of when this team should be activated.

### How Teams Execute

1. The chain runner activates a team for a step
2. The lead receives the task and the context from previous steps
3. By default, the lead briefs workers with specific assignments
4. In Standard Swarm v2 strict mode, every worker must have a valid `SPAWN_DECISION`
5. Workers execute in parallel within their domain constraints
6. The lead reviews worker output and produces a synthesized result
7. The chain runner checks till_done criteria

Some review chains can set `lead_only: true` on a team step. In lead-only mode, MAE spawns only the team lead; the lead performs the review/work directly and no team members are spawned. Use this for bounded review swarms where the desired shape is one lead per perspective instead of full squads.

### Structured Spawn Decisions

A `SPAWN_DECISION` makes worker creation explicit and auditable. In strict mode, MAE spawns only configured team members with a valid decision for that exact worker; unknown workers, duplicate decisions, invalid constraints, or missing decisions fail before worker resources are created. Strict mode can be enabled per chain step with `strict_spawn: true` or globally with the Phase 4 strict/certification environment flags. The decision is emitted before worktree creation and before `agent_spawn` as a `spawn_decision` dashboard event and a `spawn.decision` JSONL trace event so validators and dashboard tooling can reason about why the worker exists. Legacy parser aliases are accepted at boundaries, but the canonical runtime contract is the flat Phase 4 schema.

The decision constraints are enforced on execution. `allowed_tools` is checked against the worker's effective tools and applied to delegate options. `allowed_paths` becomes the worker's effective read scope and, for non-review steps, write/update scope. Absolute paths, traversal paths, broad wildcard-only scopes, and `forbidden_paths` already covered by allowed scopes are rejected in strict execution.

Required decision data:

- `need_worker`
- `worker_name`
- `spawn_type`
- `reason`
- `why_lead_cannot_do_it`
- `constraints.allowed_paths`
- `constraints.allowed_tools`
- `constraints.forbidden_paths`
- `bus_policy: isolated`
- `expected_output_schema`
- `timeout_seconds`

`bus_policy: main_bus` is intentionally rejected in v2 strict mode until the v2.1 sub-bus design exists.

Retry workers and Sr. recovery agents also emit strict spawn decisions before their `agent_spawn` events. Adapter-level `agent.start` traces include the canonical `mae_agent_id` so deterministic validation can bind Pi/Echo/A2A local agent ids back to the MAE worker authorization event.

### Steer Participants

Dashboard operators, CLI users, and API callers who send steer messages (`!pause`, `!resume`, `!stop`, `!budget`, or freeform text) are traced as **steer participants**. Each steer interaction creates a transient participant lifecycle bracket:

1. `participant_start` — registers the steer actor with kind `web-steer` or `cli-steer`, authority 90
2. `steer_action` — structured trace event with sender, source, authority, intent, target, content, and certification impact
3. `participant_end` — closes the bracket (transient, not long-lived)

Steer source is inferred from the `message_id` prefix: `tui-*` = CLI, otherwise web. Ping messages are diagnostic and do not create steer events.

Steer events affect certification:
- **Unattended mode** (default): any steer event fails the `steer_events_valid` validator check. Use this to prove a session completed without human intervention.
- **Interactive mode** (`--interactive-cert`): steer events are allowed but audited. Each steer action must have a complete `participant_start → steer_action → participant_end` lifecycle bracket. Authority must be 90, `certification_impact` must be `blocks_unattended` or `none`, and a steer stop must not mask incomplete lead lifecycles (evidence-hiding detection).

See `specs/trace-schema.md` for the full event schema and `mae validate-cert --interactive-cert` for interactive certification.

### Domain Locking

Each agent has a `domain` config that restricts what files they can read and write:

```yaml
domain:
  read: ["**/*"]                           # Can read anything
  write: ["engine/**", "**/*.ts"]          # Can only write to engine/ and .ts files
  update: ["agents/expertise/my-agent.md"] # Can update their own expertise
  delete: []                               # Cannot delete anything
```

This prevents a frontend engineer from modifying backend code, or a reviewer from editing implementation files.

### Available Teams

| Team | Role | Members |
|------|------|---------|
| Planning | Analysis and planning | Scout, Antagonist |
| Engineering | Building and implementation | Backend, Frontend, Infra Engineers, Antagonist |
| Engineering B | Parallel build with different model family | Backend Engineer (B), Antagonist (B) |
| Validation | Code review and security | Code Reviewer, Security Reviewer |
| Design | UI/UX design | Frontend Designer, Frontend Engineer, Antagonist |
| Red Team | Adversarial review | Adversarial Reviewer, Security Reviewer |
| Blue Team | Correctness verification | Correctness Reviewer, Quality Reviewer |
| Correctness Squad | Deep correctness review (swarm) | 6 specialist reviewers |
| Adversarial Squad | Adversarial analysis (swarm) | 5 fault-finding specialists |
| Quality Squad | Code quality review (swarm) | 5 quality reviewers |
| Security Squad | Security audit (swarm) | 5 security specialists |
| Domain Squad | Domain-specific review (swarm) | 5 domain reviewers |

---

## Personas

A **persona** is a markdown file that defines an agent's identity, capabilities, and constraints. Persona files live in `agents/personas/` and use YAML frontmatter for configuration and markdown body for the system prompt.

### Persona File Structure

```markdown
---
name: Backend Engineer
model: main
expertise: agents/expertise/backend-engineer.md
max_expertise_lines: 7000
skills:
  - path: agents/skills/active-listener.md
    use-when: Always. Read the conversation log before every response.
  - path: agents/skills/mental-model.md
    use-when: Read at task start for context.
tools:
  - read
  - write
  - edit
  - bash
  - grep
  - find
  - glob
domain:
  read: ["**/*"]
  write: ["engine/**", "**/*.ts"]
  update: ["agents/expertise/backend-engineer.md"]
  delete: []
---

# Purpose

You are a Backend Engineer -- you design, implement, and maintain
server-side systems including APIs, data layers, and authentication.

## Role
[What this agent does]

## Domain Knowledge
[Deep knowledge about the agent's specialty]

## Rules
[Behavioral constraints]
```

### Key Frontmatter Fields

| Field | Purpose |
|-------|---------|
| `name` | Display name for the agent |
| `model` | Model alias (`quality`, `main`, `fast`, `pro`) |
| `expertise` | Path to auto-maintained expertise file |
| `max_expertise_lines` | Maximum lines loaded from expertise file |
| `skills` | Reusable skill definitions the agent loads |
| `tools` | Tools the agent can use (read, write, edit, bash, etc.) |
| `domain` | File access constraints (read/write/update/delete globs) |

### Creating a New Persona

```bash
mae new-agent "Database Expert" worker Engineering main
```

This scaffolds a persona file and an empty expertise file. Edit the persona to add domain knowledge and rules.

---

## Adapters

An **adapter** bridges MAE to an actual agent runtime. MAE does not run agents itself -- it delegates work through adapters.

### Available Adapters

| Adapter | Purpose | How it works |
|---------|---------|--------------|
| **Pi** | Real work via RPC | Sends tasks to a running Pi agent instance over RPC. The primary production adapter. |
| **Echo** | Testing | Simulates agent work by echoing the prompt back. No LLM calls, no cost. Use with `--dry-run`. |
| **A2A** | Agent-to-Agent protocol | Delegates work to any A2A-compatible agent over HTTP. Supports discovery, streaming, and bearer auth. |

### Adapter Selection

MAE selects adapters in this priority:
1. `--adapter <name>` flag on the command
2. `--dry-run` flag forces the echo adapter
3. Auto-detection: MAE checks each non-echo adapter's availability and uses the first one that responds

### A2A Discovery

You can discover A2A agents at a URL:

```bash
mae discover http://agent-host:41271
```

```
Discovered A2A agent:
  Name: Example Agent
  URL: http://agent-host:41271
  Skills:
    - code-review: Reviews code for quality and security
  Streaming: yes
```

Configure A2A via environment variables or flags:

```bash
mae task "Review this code" --adapter a2a --a2a-url http://agent:41271 --a2a-token my-token
```

---

## Traces

A **trace** is a JSONL file that records every event in a session -- agent spawns, tool calls, chain step transitions, errors, costs, and more. Traces are the raw data that powers scoring, fingerprinting, replay, and the Ralph loop.

### Where Traces Live

Traces are stored at `~/.mae/traces/` by default (override with `MAE_TRACE_DIR`). Each session produces one file named `{session_id}.jsonl`.

### What's in a Trace

Each line is a JSON object with a `type` field:

| Event Type | What it records |
|------------|----------------|
| `session.start` | Goal, chain, working directory, config hash |
| `session.end` | Final status, duration, total cost, token count |
| `agent.start` | Persona, model, team, role, tools |
| `agent.end` | Grade, duration, cost, output preview |
| `agent.error` | Error message, error type, retry count |
| `chain.step.start` | Step number, team name |
| `chain.step.end` | Step status, duration |
| `tool.call` | Tool name, args preview, success, duration |
| `llm.call` | Model, prompt/completion tokens, duration, cost |
| `self_heal` | Trigger, action, model upgrade details |
| `verify` | Check type, pass/fail, output preview |
| `orch.decision` | Decision type, reason, context |
| `log` | General log entries (DEBUG/INFO/WARN/ERROR/CRITICAL) |

### Inspecting Traces

```bash
mae traces           # List recent traces
mae traces <id>      # Show event breakdown for a specific trace
mae score <id>       # Score a trace with deterministic checks
```

---

## Golden Traces

A **golden trace** is a session trace that has been manually marked as a verified reference -- either a known-good run (`pass`) or a known-bad run (`fail`). Golden traces serve as baselines for regression testing.

### How Golden Traces Are Used

1. The Ralph loop loads golden traces alongside recent traces for evaluation
2. Only `pass` golden traces are used as baseline references
3. Before accepting a mutation, the ratchet verifies scores do not regress against golden baselines
4. The `replay` command can re-run a golden trace's goal to detect behavioral drift

### Managing Golden Traces

```bash
# Mark a good run as golden
mae golden add 2dbc90f5 --notes "Clean 3-step plan-build-review"

# Mark a bad run for regression detection
mae golden add 8fa2c1b3 --verdict fail --notes "Cost overrun from agent loop"

# List all golden traces
mae golden list
```

Golden traces are stored in `~/.mae/traces/golden.json`.

---

## Scoring

The `mae score` command runs five deterministic checks against a session trace:

1. **session_completed** -- Did the session finish with `completed` status?
2. **all_steps_executed** -- Were all chain steps started and finished (no missing step ends)?
3. **no_agent_failures** -- Were there zero `agent.error` events?
4. **no_error_logs** -- Were there zero ERROR or CRITICAL log entries?
5. **cost_reasonable** -- Was total cost under $5.00?

The overall result is:
- **PASS** -- all five checks pass
- **PARTIAL** -- session completed but some checks failed
- **FAIL** -- session did not complete

Scoring also extracts a behavioral fingerprint (see below) and displays it alongside the check results.

---

## Behavioral Fingerprinting

A **behavioral fingerprint** captures what an agent session *did* at a structural level -- not the raw text output, but the pattern of actions. This makes it possible to compare sessions meaningfully despite LLM non-determinism.

### What a Fingerprint Contains

| Component | What it tracks |
|-----------|---------------|
| `toolSequence` | Ordered list of tools called (read, write, edit, bash, etc.) |
| `agentCount` | Total number of agents spawned |
| `teamSequence` | Ordered list of unique teams activated |
| `stepCount` | Number of chain steps executed |
| `errorCount` | Number of agent errors + ERROR/CRITICAL logs |
| `statusTransitions` | Sequence of status changes (step completions, session end) |

### How Comparison Works

`mae compare <id1> <id2>` extracts fingerprints from both traces and computes similarity:

- Scalar values (agent count, step count, error count) are compared directly
- Sequences (tools, teams, status transitions) use Jaccard similarity on bigrams to capture order sensitivity
- The final similarity score is the average across all components (0-100%)

This tells you whether two runs of the same goal took a similar path, even if the exact output text differs.

---

## Replay

`mae replay <id>` re-runs a past session's original goal through the engine, then compares the new trace's fingerprint to the old one. This answers the question: "If I run the same task again, does the system behave similarly?"

### Why Replay Matters

LLM-based agents are non-deterministic. The same prompt can produce different outputs, tool call sequences, and even different chain paths. Replay detects:

- **Behavioral drift** -- an agent that used to complete in 3 steps now takes 7
- **Regressions** -- a persona change that causes failures where there were none
- **Cost changes** -- the same task costs $0.50 one day and $3.00 the next

### What Replay Does

1. Loads the old trace and extracts the goal and chain name
2. Runs the goal through the engine with the current configuration
3. Extracts behavioral fingerprints from both the old and new traces
4. Compares fingerprints and reports similarity score and differences

---

## The Ralph Loop

The Ralph loop is MAE's self-improvement system. It uses a three-population architecture where no agent modifies its own configuration -- improvement happens through analysis, proposal, and a ratchet that only accepts non-regressing changes.

### Three Populations

```
Population A (Workers)    -- The existing personas that execute real tasks
      |
      | produce traces
      v
Population B (Evaluator)  -- Analyzes traces, identifies weak patterns
      |
      | findings
      v
Population C (Evolver)    -- Proposes config mutations based on findings
      |
      | mutations
      v
Git Ratchet               -- Tests mutations, accepts improvements, rejects regressions
```

### How It Works

1. **Load traces** -- Ralph collects the 20 most recent traces plus all golden traces
2. **Evaluate (Population B)** -- An LLM analyzes the traces and produces findings: "Backend Engineer failed on error handling in 3/5 sessions", "Scout timed out when scanning large directories"
3. **Propose mutations (Population C)** -- A different LLM proposes concrete config changes: "Append error boundary handling rules to Backend Engineer's system prompt", "Remove bash tool from Scout persona"
4. **Apply and test** -- Each mutation is applied to the persona file. The ratchet verifies that the config still parses correctly and scores do not regress against golden baselines
5. **Accept or reject** -- Accepted mutations are git-committed. Rejected mutations are reverted immediately.

### Running the Ralph Loop

```bash
# Full run with defaults (5 iterations, quality model)
mae ralph

# Preview without making changes
mae ralph --dry-run

# More iterations with a specific model
mae ralph --iterations 10 --model quality
```

### What `--dry-run` Shows

Dry-run mode performs all analysis and proposes mutations but does not write any files. It reports what would be accepted or rejected, letting you review changes before committing to them.

### The Git Ratchet

Every accepted mutation is committed as a separate git commit with a message like:

```
ralph: mutate backend-engineer -- Add explicit error boundary handling to Rules section
```

This makes it trivial to review, cherry-pick, or revert individual improvements. The ratchet guarantees monotonic improvement -- scores can only stay the same or get better, never worse.
