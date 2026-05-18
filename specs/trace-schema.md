# MAE Trace Schema v1

> Contract between the MAE pipeline and the Ralph/Karpathy learning loop.
> Every session produces a JSONL trace file following this schema.
> Align with OpenTelemetry span conventions for tool compatibility (Arize Phoenix, Langfuse).

## Core Fields (every event)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ts` | ISO 8601 string | yes | Timestamp with ms precision |
| `type` | string | yes | Event type (see below) |
| `id` | string | yes | Unique event ID (ulid or uuid) |
| `parent_id` | string | no | Parent event ID — forms the call tree |
| `session_id` | string | yes | Session this event belongs to |

## Event Types

### Session Lifecycle

```jsonl
{"ts":"...","type":"session.start","id":"...","session_id":"...","goal":"Build auth middleware","chain":"plan-build-review","working_dir":"/path/to/repo","config_hash":"abc123"}

{"ts":"...","type":"session.end","id":"...","session_id":"...","status":"completed|error|paused","duration_ms":120000,"total_cost":1.23,"total_tokens":45678,"agents_spawned":5,"agents_failed":1}
```

### Chain Step Lifecycle

```jsonl
{"ts":"...","type":"chain.step.start","id":"step-2","parent_id":"session-abc","session_id":"...","step":2,"name":"build","team":"engineering"}

{"ts":"...","type":"chain.step.end","id":"...","parent_id":"step-2","session_id":"...","step":2,"name":"build","status":"completed|failed|skipped","duration_ms":45000}
```

### Participant Presence and Heartbeat

Phase 2 adds participant events as the canonical visibility layer for orchestrator, leads, workers, synthesis, validators, web/CLI steer actors, and system actors. Agent lifecycle events remain for backward compatibility; participant events are the stable source for presence, activity, stale/offline policy, and later dashboard agent-pool views.

```jsonl
{"ts":"...","type":"participant.start","id":"...","parent_id":"orch-1","session_id":"...","agent_id":"pi-correctness-lead","participant_id":"pi-correctness-lead","kind":"lead","status":"active","name":"Correctness Lead","role":"lead","team":"Correctness Review","model":"gpt-5.5","current_task":"agent:lead","last_heartbeat_ts":"...","capabilities":{"canReceiveSteer":true,"canSteer":true,"canUseTools":true,"canSpawnWorkers":true,"canReviewWorkers":true,"can_delegate":true,"authority":70,"tools":["read","bash"],"domain_read":["engine/**"],"domain_write":[],"domain_update":[]}}

{"ts":"...","type":"participant.activity","id":"...","session_id":"...","agent_id":"pi-correctness-lead","participant_id":"pi-correctness-lead","status":"active","current_tool":"read","current_task":"README.md","last_event":"tool_call","last_heartbeat_ts":"..."}

{"ts":"...","type":"participant.heartbeat","id":"...","session_id":"...","agent_id":"pi-correctness-lead","participant_id":"pi-correctness-lead","status":"active","last_event":"cost_update","last_heartbeat_ts":"...","cost_usd":0.12,"tokens_used":4200}

{"ts":"...","type":"participant.stale","id":"...","session_id":"...","agent_id":"pi-correctness-lead","participant_id":"pi-correctness-lead","status":"stale","reason":"no activity for 60s","last_heartbeat_ts":"..."}

{"ts":"...","type":"participant.end","id":"...","session_id":"...","agent_id":"pi-correctness-lead","participant_id":"pi-correctness-lead","status":"completed|failed|blocked","last_event":"agent_done","last_heartbeat_ts":"...","cost_usd":0.12,"tokens_used":4200}
```

Participant fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `participant_id` | string | yes | Stable participant ID, usually matching `agent_id` |
| `kind` | string | start | `orchestrator|lead|worker|sr|synthesis|validator|web-steer|cli-steer|system` |
| `status` | string | yes | `starting|active|idle|stale|completed|failed|blocked` |
| `name` | string | start | Human-readable participant name |
| `role` | string | no | Agent role or future steer/system role |
| `team` | string | no | Owning team/squad when applicable |
| `model` | string | no | Model/provider hint when applicable |
| `current_task` | string | no | Bounded current task/activity description |
| `current_tool` | string | no | Tool currently being invoked, when available |
| `last_event` | string | no | Event that caused this participant update |
| `last_heartbeat_ts` | ISO 8601 string | yes | Latest liveness timestamp emitted by MAE |
| `cost_usd` / `tokens_used` | number | no | Latest participant economics snapshot |
| `capabilities` | object | no | Bounded policy metadata for later validator/dashboard checks |

Heartbeat volume is intentionally bounded: MAE emits heartbeats on lifecycle/cost/activity transitions rather than a high-frequency timer in Phase 2.

### Agent Lifecycle

```jsonl
{"ts":"...","type":"agent.start","id":"agent-w1","parent_id":"step-2","session_id":"...","agent_id":"pi-frontend-dev","persona":"frontend-dev","model":"claude-sonnet-4-6","team":"engineering","role":"worker","prompt_hash":"def456","tools":["read","write","edit","bash"],"extensions":["damage-control"],"domain_write":["src/frontend/**"]}

{"ts":"...","type":"agent.end","id":"...","parent_id":"step-2","session_id":"...","agent_id":"pi-frontend-dev","grade":"VERIFIED|PARTIAL|FAILED","output_hash":"...","output_artifact":"session-id/artifacts/agent-output-abc123.txt","output_preview":"First 500 chars...","duration_ms":45000,"cost":0.45,"tokens":{"prompt":8000,"completion":3000,"cache_read":5000}}
```

### Tool Calls — Behavioral Fingerprint

```jsonl
{"ts":"...","type":"tool.call","id":"tool-xyz","parent_id":"agent-w1","session_id":"...","agent_id":"pi-frontend-dev","tool":"bash","args_preview":"bun tsc --noEmit","args_hash":"...","success":true,"duration_ms":3200,"exit_code":0,"output_preview":"No errors"}

{"ts":"...","type":"tool.call","id":"tool-abc","parent_id":"agent-w1","session_id":"...","agent_id":"pi-frontend-dev","tool":"write","args_preview":"src/components/Button.tsx","args_hash":"...","success":true,"bytes_written":1234}

{"ts":"...","type":"tool.call","id":"tool-def","parent_id":"agent-w1","session_id":"...","agent_id":"pi-frontend-dev","tool":"read","args_preview":"src/types.ts","args_hash":"...","success":true,"bytes_read":5678}
```

### LLM Calls — Token Economics

```jsonl
{"ts":"...","type":"llm.call","id":"llm-001","parent_id":"agent-w1","session_id":"...","agent_id":"pi-frontend-dev","model":"claude-sonnet-4-6","provider":"litellm","prompt_tokens":8234,"completion_tokens":2341,"cache_read_tokens":5000,"cache_write_tokens":0,"duration_ms":2800,"cost":0.034}
```

### Errors and Failures — Learning Signal

```jsonl
{"ts":"...","type":"agent.error","id":"...","parent_id":"step-2","session_id":"...","agent_id":"pi-backend-dev","error":"timeout after 300s","error_type":"timeout","phase":"build","retry_count":2}

{"ts":"...","type":"worker.failed","id":"...","parent_id":"step-2","session_id":"...","agent_id":"pi-backend-dev","team":"engineering","error":"type check failed after 3 retries","final_output_preview":"..."}
```

### Self-Healing Events

```jsonl
{"ts":"...","type":"self_heal","id":"...","parent_id":"agent-w1","session_id":"...","agent_id":"pi-frontend-dev","trigger":"test_failure","action":"model_upgrade","from_model":"sonnet","to_model":"opus","attempt":2}
```

### Verification Results — Deterministic Checks

```jsonl
{"ts":"...","type":"verify","id":"...","parent_id":"step-2","session_id":"...","step":"build","check":"bun tsc --noEmit","check_type":"deterministic","pass":true,"duration_ms":1200,"output_preview":""}

{"ts":"...","type":"verify","id":"...","parent_id":"step-2","session_id":"...","step":"build","check":"bun test","check_type":"deterministic","pass":false,"duration_ms":5400,"output_preview":"3 failures in auth.test.ts","failure_count":3}
```

### Orchestrator Decisions — Why the system did what it did

```jsonl
{"ts":"...","type":"orch.decision","id":"...","parent_id":"session-abc","session_id":"...","decision":"retry_worker","reason":"grade FAILED, attempts 1/3","context":{"agent_id":"pi-backend-dev","grade":"FAILED","max_retries":3}}

{"ts":"...","type":"orch.decision","id":"...","parent_id":"session-abc","session_id":"...","decision":"spawn_senior","reason":"worker failed 3x, escalating","context":{"failed_agent":"pi-backend-dev","senior_model":"opus"}}

{"ts":"...","type":"orch.decision","id":"...","parent_id":"session-abc","session_id":"...","decision":"skip_step","reason":"previous step produced empty output","context":{"step":3,"name":"review"}}
```

### Post-Session Outcome — Reality Signal for Ralph Loop

```jsonl
{"ts":"...","type":"outcome","id":"...","session_id":"...","source":"human|evaluator|production","verdict":"success|partial|failure|regression","notes":"code compiled but missed edge case in error handler","filed_issue":213,"related_sessions":["prev-session-id"]}

{"ts":"...","type":"outcome","id":"...","session_id":"...","source":"evaluator","verdict":"regression","notes":"tool call sequence diverged from golden trace at step 3","regression_from":"golden-session-id","score":0.72,"score_baseline":0.91}
```

## Storage

### Trace Files
```
~/.mae/traces/{session_id}.jsonl       # One file per session
~/.mae/traces/{session_id}/artifacts/  # Full per-agent output artifacts
~/.mae/traces/index.db                  # SQLite index for fast lookup
```

Configurable via `MAE_TRACE_DIR` environment variable.
Agent output artifacts are bounded by `MAE_AGENT_OUTPUT_ARTIFACT_CHARS` (default `20000`).

### SQLite Index Schema
```sql
CREATE TABLE traces (
  session_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  chain TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  total_cost REAL,
  total_tokens INTEGER,
  agents_spawned INTEGER,
  agents_failed INTEGER,
  config_hash TEXT,
  outcome_verdict TEXT,
  outcome_source TEXT,
  trace_path TEXT NOT NULL
);

CREATE INDEX idx_traces_status ON traces(status);
CREATE INDEX idx_traces_date ON traces(started_at);
CREATE INDEX idx_traces_config ON traces(config_hash);
CREATE INDEX idx_traces_outcome ON traces(outcome_verdict);
```

## Design Decisions

1. **`prompt_hash` not full prompt** — Prompts are 1-10K tokens. Store the hash, let the Evolver look up the full prompt from the config repo when needed.

2. **`args_preview` + `args_hash`** — Full args would bloat traces (file contents in write calls). Preview gives enough for behavioral fingerprinting. Hash enables exact comparison across replays.

3. **`output_preview` not full output** — Same rationale. Full output stored in session artifacts, not the trace.

4. **`parent_id` for call tree** — Aligns with OpenTelemetry `parent_span_id`. Enables tree reconstruction for the Ralph loop to understand causality ("this failure happened because this tool call returned error").

5. **`orch.decision` events** — The Ralph loop needs to understand not just WHAT happened but WHY the orchestrator made each decision. Without these, the Evolver can only correlate configs with outcomes, not understand the decision path.

6. **`outcome` is separate from `session.end`** — `session.end` records what the system thinks happened. `outcome` records what actually happened (from a human, evaluator, or production signal). These can disagree — the system says "completed" but the human says "partial" because the code had a bug the tests didn't catch.

## Compatibility

The schema is designed to be importable by:
- **Arize Phoenix** (OTel-native, self-hostable) — map `id`/`parent_id` to span_id/parent_span_id
- **Langfuse** (MIT, self-hostable) — map events to Langfuse trace/span/generation types
- **AgentAssay** — extract tool.call sequences for behavioral fingerprinting
- **AgentEvals** — score pre-recorded traces without re-running

If we ever outgrow the local SQLite + JSONL setup, the trace data ports cleanly to any OTel-compatible backend.
