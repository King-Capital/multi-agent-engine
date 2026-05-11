# Observability Stack

MAE provides four layers of observability: structured logging, trace recording, Langfuse integration, and a real-time dashboard. Data flows from the engine through all layers simultaneously.

---

## Data Flow

```
Engine (orchestrator, chain-runner, adapters)
  |
  |-- stderr (JSONL)           Always on. Human/machine readable logs.
  |
  |-- Trace Recorder           Always on. Per-session JSONL files at ~/.mae/traces/
  |
  |-- Langfuse Sink            When configured. Sends traces, spans, and events to Langfuse.
  |
  +-- Dashboard Events         When connected. SSE events to the dashboard for real-time UI.
```

Every log entry goes through the structured logger. The logger writes to stderr and dispatches to all registered sinks (trace recorder, Langfuse). The dashboard receives events separately via HTTP.

---

## Structured Logging

All engine logging goes through a JSONL logger. No component uses `console.log` directly.

### Log Format

Every log line is a JSON object written to stderr:

```json
{
  "ts": "2026-05-10T14:30:00.000Z",
  "level": "INFO",
  "component": "orchestrator",
  "msg": "Session started",
  "session_id": "2dbc90f5-abc1-4def-...",
  "chain": "plan-build-review"
}
```

### Log Levels

| Level | When to use |
|-------|-------------|
| `DEBUG` | Detailed internal state (not shown by default) |
| `INFO` | Normal operation: session start, step transitions, agent spawns |
| `WARN` | Recoverable issues: retries, fallbacks, degraded behavior |
| `ERROR` | Failures that affect the session: agent errors, adapter failures |
| `CRITICAL` | System-level failures: config parse errors, budget exhaustion |

### Controlling Log Level

Set the `MAE_LOG_LEVEL` environment variable:

```bash
# Show everything including debug
MAE_LOG_LEVEL=DEBUG mae task "my task"

# Quiet mode -- only errors and critical
MAE_LOG_LEVEL=ERROR mae task "my task"
```

Default level is `INFO`.

### Child Loggers

Components create child loggers that automatically include context fields:

```
orchestrator           -> {component: "orchestrator"}
  session-abc          -> {component: "orchestrator", session_id: "abc"}
    pi-adapter/agent-1 -> {component: "pi-adapter", session_id: "abc", agent_id: "agent-1"}
```

This means every log line from an agent includes the session ID and agent ID without the caller needing to pass them explicitly.

---

## Trace Recording

The trace recorder is a log sink that writes one JSONL file per session to disk. It is always active -- no environment variables needed to enable it.

### Trace Location

Default: `~/.mae/traces/`

Override with `MAE_TRACE_DIR`:

```bash
MAE_TRACE_DIR=/var/log/mae/traces mae task "my task"
```

### Trace File Format

Each trace file is named `{session_id}.jsonl`. Each line is a JSON event following the trace schema defined in `specs/trace-schema.md`.

Events are typed by the `type` field:

```json
{"ts":"...","type":"session.start","id":"...","session_id":"...","goal":"Fix auth bug","chain":"build-verify"}
{"ts":"...","type":"agent.start","id":"...","session_id":"...","persona":"backend-engineer","model":"main","team":"Engineering"}
{"ts":"...","type":"tool.call","id":"...","session_id":"...","tool":"edit","success":true,"duration_ms":150}
{"ts":"...","type":"agent.end","id":"...","session_id":"...","grade":"PASS","cost":0.45}
{"ts":"...","type":"session.end","id":"...","session_id":"...","status":"completed","total_cost":1.23,"duration_ms":180000}
```

### How Log Entries Map to Trace Events

The trace recorder inspects each log entry's `component` and `msg` fields to classify it into a trace event type. For example:

- A log from `orchestrator` with `msg: "Session started"` becomes `session.start`
- A log from `pi-adapter` with `msg: "Delegating started"` becomes `agent.start`
- A log from `chain-runner` with `msg: "Step 2 complete"` becomes `chain.step.end`

This means you get structured traces automatically -- no manual trace instrumentation required.

### Inspecting Traces

```bash
# List recent trace files
mae traces

# Show event breakdown for a session
mae traces 2dbc90f5

# Score a session against deterministic checks
mae score 2dbc90f5

# Compare two sessions by behavioral fingerprint
mae compare 2dbc90f5 8fa2c1b3
```

---

## Langfuse

[Langfuse](https://langfuse.com) is an observability platform for LLM applications. MAE integrates with Langfuse to provide a visual UI for exploring traces, managing prompts, running evaluations, and building datasets.

### Configuration

Set these environment variables to enable Langfuse:

```bash
LANGFUSE_PUBLIC_KEY="pk-lf-..."
LANGFUSE_SECRET_KEY="sk-lf-..."
LANGFUSE_HOST="http://your-langfuse-host:3000"  # Optional, defaults to http://10.71.20.73:3000
```

When both keys are set, MAE automatically registers a Langfuse sink that sends data in real time. When not set, Langfuse is silently disabled -- no errors, no impact on operation.

### What You See in Langfuse

**Traces** -- Each MAE session appears as a Langfuse trace. The trace name is the session goal, and it contains spans for each agent delegation and team activation.

**Spans** -- Agent delegations, team activations, worker spawns, and lead reviews appear as nested spans within the session trace. Each span includes metadata like model, team, and domain constraints.

**Events** -- Status transitions and errors appear as Langfuse events. Errors are tagged with `ERROR` level for easy filtering.

**Scores** -- Registered score types include:
- `session_completion` -- Did the session complete?
- `agent_grade` -- Grade assigned by the validation team
- `cost_efficiency` -- Cost relative to budget
- `worker_success_rate` -- Percentage of workers that succeeded
- `chain_step_completion` -- Percentage of chain steps completed

**Prompts** -- All 20 agent personas are registered as Langfuse prompts with version tracking.

**Datasets** -- Pre-configured datasets:
- `mae-golden-sessions` -- Known-good session runs
- `mae-failure-cases` -- Sessions that failed for analysis
- `mae-prompt-experiments` -- A/B prompt testing data

**Annotation Queues** -- For human review:
- Session Review -- General session quality assessment
- Agent Quality -- Individual agent performance grading
- Failure Triage -- Categorizing and understanding failures

### Checking Langfuse Status

```bash
mae health
```

The health report includes a Langfuse section showing whether it is configured and reachable.

---

## Dashboard

The MAE dashboard is a React SPA (in `dashboard-next/src/`) backed by a Go API server (in `dashboard/main.go`). It shows real-time session progress via Server-Sent Events (SSE).

### Accessing the Dashboard

Default URL: `http://localhost:8400` (or the value of `MAE_DASHBOARD_URL`).

### What the Dashboard Shows

- **Session list** -- All sessions with status, cost, agent count, and goal
- **Session detail** -- Real-time view of a running session: which chain step is active, which agents are working, their output as it streams in
- **Agent activity** -- Which agents are spawned, their model, team, and current status
- **Team coordination** -- How teams are activated and how work flows between them
- **Cost tracking** -- Per-session and per-agent cost in real time

### Dashboard Health

Check connectivity from the CLI:

```bash
mae health       # Includes dashboard status
mae info         # Also shows dashboard connectivity
```

### API Endpoints

The dashboard exposes a REST API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Dashboard health check |
| `/api/sessions` | GET | List all sessions |
| `/api/sessions/:id/status` | PATCH | Update session status |

Authenticated endpoints require the `MAE_API_TOKEN` header:

```bash
curl -H "Authorization: Bearer $MAE_API_TOKEN" http://localhost:8400/api/sessions
```
