# Goal: Langfuse Observability + Ralph Verification Ratchet (SUPERSEDED)

> **SUPERSEDED** — Split into two goals after critical analysis:
> - [Goal 1: Langfuse Data Pipeline](goal-1-langfuse-data-pipeline.md) — ship first
> - [Goal 2: Ralph Ratchet + LLM-as-Judge](goal-2-ralph-ratchet-and-judge.md) — depends on Goal 1
>
> Original combined goal preserved below for reference. Created 2026-05-12.

Build production-grade Langfuse observability + the replay verification ratchet so `mae ralph --apply` safely auto-applies mutations verified by both deterministic scoring AND LLM-as-judge evals via Langfuse.

## Current State

### Ralph Loop (DONE — advisory only)
- Three-population architecture fully implemented (ralph-loop.ts, ralph-evaluator.ts, ralph-evolver.ts)
- 1,750+ JSONL trace files at ~/.mae/traces/
- Runs advisory-only: evaluates traces, proposes persona/config mutations, writes NO files
- replay.ts has scoring (5 deterministic checks), behavioral fingerprinting (Jaccard bigram similarity), golden trace registry

### Langfuse Integration (BROKEN — confirmed by live inspection)
What currently works:
- langfuse-sink.ts creates session-level traces on "Session started" / "Session ended" ✓
- Agent/team/worker/review delegation creates spans ✓
- Status transitions and errors create events ✓

What is broken or missing (confirmed in live Langfuse UI):
1. **No generations** — `llm.call` events exist in trace-recorder.ts (line 185-190) with model, prompt_tokens, completion_tokens, duration_ms, cost — but langfuse-sink.ts has ZERO handlers for `llm.call`. No `generation-create` events are ever emitted.
2. **No scores** — langfuse-admin.ts provisions 7 score configs (session_completion, agent_grade, cost_efficiency, worker_success_rate, chain_step_completion, judge_overall_quality, judge_release_readiness) but no code ever calls the Langfuse `/api/public/scores` endpoint.
3. **No userId** — `trace-create` at langfuse-sink.ts:52 never sets the `userId` field. Should be the session initiator or "mae-engine".
4. **Environment always "default"** — No `environment` or `release` field set on trace-create. Should use `process.env.MAE_ENV ?? "production"` and the VERSION file for release.
5. **No input** — trace-create input is `entry.task_preview ?? entry.goal` which is often undefined. The full goal/task text must always be captured.
6. **Output is weak** — trace output is a hardcoded string: `"Status: ${status}, Cost: $${cost}"` (line 72). Should be a structured object with status, cost, duration, steps completed, agents used, errors.
7. **No token usage or costs** — No `usage` object (promptTokens, completionTokens, totalTokens) on any event. Token counts exist in trace-recorder's `llm.call` handler but never reach Langfuse. No `calculatedTotalCost` field.
8. **Tool calls invisible** — `tool.call` events exist in trace-recorder but no Langfuse spans created for them.
9. **No prompt versioning** — Persona system prompts not linked to Langfuse prompt objects.
10. **Span I/O empty** — Agent spans have `input` as a 500-char preview but never have `output`. Worker and review spans have zero I/O.

### Infrastructure Available
- Langfuse v3 at 10.71.20.73:3000 (running, accessible)
- LiteLLM proxy at 10.71.1.33:4000 (all LLM calls route through here)
- Score configs already provisioned: session_completion, agent_grade, cost_efficiency, worker_success_rate, chain_step_completion, judge_overall_quality, judge_release_readiness
- Annotation queues configured: Session Review, Agent Quality, Failure Triage
- Datasets configured: mae-golden-sessions, mae-failure-cases, mae-prompt-experiments
- VERSION file exists for release tagging

## What to Build

### Phase 1: Fix Langfuse Trace Quality (langfuse-sink.ts)

#### 1A. Trace metadata (fixes: no userId, env always default, weak input/output)

On `trace-create` (line 52), add:
- `userId`: `entry.user_id ?? entry.initiator ?? "mae-engine"`
- `release`: read from VERSION file at startup (e.g., "1.0.4")
- `environment`: `process.env.MAE_ENV ?? "development"` (set to "production" on CT 272)
- `tags`: `[entry.chain, entry.adapter].filter(Boolean)`
- `input`: structured object `{ goal: entry.goal ?? entry.name, task: entry.task, chain: entry.chain }` — never undefined
- `output` (on session end): structured object `{ status, cost_usd, duration_ms, steps_completed, steps_total, agents_used, errors, final_output_preview }`

#### 1B. Generation tracking (fixes: no generations, no token usage, no costs)

Add handler for log entries where trace_type is `llm.call` OR message matches LLM call patterns:
```typescript
buffer.push({
  id: uid(), type: "generation-create", timestamp: entry.ts,
  body: {
    id: uid(),
    traceId: currentTraceId,
    parentObservationId: currentAgentSpanId,  // link to parent agent span
    name: `${entry.persona ?? entry.agent ?? "llm"}/${entry.purpose ?? "call"}`,
    model: entry.model,
    input: entry.prompt_preview ?? entry.input,
    output: entry.completion_preview ?? entry.output,
    usage: {
      promptTokens: entry.prompt_tokens,
      completionTokens: entry.completion_tokens,
      totalTokens: (entry.prompt_tokens ?? 0) + (entry.completion_tokens ?? 0),
    },
    metadata: {
      agent_id: entry.agent_id,
      team: entry.team,
      adapter: entry.adapter,
      duration_ms: entry.duration_ms,
      cost_usd: entry.cost,
    },
  },
});
```

IMPORTANT: This requires tracking `currentAgentSpanId` — when an agent span is created, store its ID so child generations can reference it as `parentObservationId`. Use a `Map<agent_id, spanId>` for concurrent agents.

#### 1C. Tool call spans (fixes: tool calls invisible)

Add handler for `tool.call` entries:
```typescript
buffer.push({
  id: uid(), type: "span-create", timestamp: entry.ts,
  body: {
    id: uid(),
    traceId: currentTraceId,
    parentObservationId: currentAgentSpanId,
    name: `tool/${entry.tool ?? "unknown"}`,
    input: entry.args_preview ? sanitize(entry.args_preview).slice(0, 2000) : undefined,
    output: entry.output_preview?.slice(0, 2000),
    metadata: { success: entry.success, exit_code: entry.exit_code, duration_ms: entry.duration_ms },
  },
});
```

#### 1D. Span I/O enrichment (fixes: span output empty)

- When agent.end events come through, update the corresponding agent span with `output` (agent's grade + output preview) and `endTime`
- When chain.step.end events come through, update the team span with completion status and duration
- This requires a spanId lookup map: `Map<agent_id|team_name, spanId>`

### Phase 2: Score Pipeline

#### 2A. Deterministic scores (computed locally, sent to Langfuse)

After session ends, compute and POST to `/api/public/scores`:
- `session_completion`: 1.0 if completed, 0.5 if partial, 0.0 if error/timeout (trace-level)
- `agent_grade`: per-agent grade from lead review, mapped 0.0-1.0 (observation-level, on agent span)
- `cost_efficiency`: 1.0 - (cost / budget_limit), clamped 0-1 (trace-level)
- `worker_success_rate`: successful_workers / total_workers (trace-level)
- `chain_step_completion`: completed_steps / total_steps (trace-level)

Score events use the Langfuse score API:
```
POST /api/public/scores
{ name, traceId, observationId?, value, comment }
```

#### 2B. LLM-as-judge scores

After deterministic scores are sent, trigger judge evaluation:
- Call the `quality` tier model (claude-opus-4-6) via LiteLLM with the session trace as context
- Evaluate against two rubrics:
  - `judge_overall_quality`: Was the goal achieved? Was output correct and complete? (0.0-1.0)
  - `judge_release_readiness`: Production quality? Error handling? Completeness? (0.0-1.0)
- Send judge scores to Langfuse with the judge's reasoning as `comment`
- Tag the trace with `evaluated: true` after judging

### Phase 3: Prompt Versioning

When agents load at session start:
- Upsert each persona's system prompt to Langfuse prompt registry via `POST /api/public/v2/prompts`
- On each generation, set `promptName` and `promptVersion` to link the call to its prompt version
- When Ralph mutates a persona, create a new prompt version in Langfuse

### Phase 4: Verification Ratchet (ralph-loop.ts)

Before applying any ConfigMutation:
1. Snapshot the target file
2. Apply mutation to temp copy
3. Re-run golden traces involving affected agent/chain via `mae replay`
4. Score replayed sessions — pull BOTH:
   - Local deterministic scores from replay.ts
   - Langfuse scores if available (judge_overall_quality, session_completion)
5. ACCEPT only if:
   - All golden fingerprint similarity >= `min_golden_similarity` (default 0.85)
   - No deterministic score regresses
   - No Langfuse judge score regresses (if scores exist)
   - At least `min_golden_coverage` golden traces tested (default 3)
6. REJECT and rollback if any regression
7. Log accept/reject with full evidence to trace + Langfuse

### Phase 5: CLI + Config

#### `--apply` flag on `mae ralph`
- Default remains advisory (zero behavior change)
- `--apply`: evaluate → propose → verify ratchet → apply if safe
- `--apply --dry-run`: show what WOULD be applied without writing
- Applied mutations get git commit: `ralph: {target} {action} (ratchet-verified)`

#### Ratchet config in configs/model-routing.yaml
```yaml
ratchet:
  min_golden_similarity: 0.85
  max_score_regression: 0
  min_golden_coverage: 3
  judge_model: quality
  require_langfuse_scores: false  # true once pipeline is stable
```

#### Mutation journal
- Write to ~/.mae/ralph-journal.jsonl
- Entry: timestamp, mutation, before/after fingerprints, all scores (local + Langfuse), accept/reject, reasoning
- `mae ralph history` to view journal

### Phase 6: Tests

Langfuse sink tests:
- Test: generation-create events emitted for llm.call entries with correct usage fields
- Test: tool call spans created with sanitized input
- Test: trace-create includes userId, environment, release, tags
- Test: structured input/output on traces (not string templates)
- Test: span lookup map correctly tracks agent→spanId for parent linking
- Test: scores sent after session end with correct values
- Test: graceful degradation when Langfuse is unreachable (no crash, local scoring still works)

Ratchet tests:
- Test: mutation accepted when all scores improve
- Test: mutation rejected when deterministic score regresses
- Test: mutation rejected when Langfuse judge score regresses
- Test: mutation rejected when insufficient golden coverage
- Test: file rollback on rejection
- Test: journal entries written correctly
- Test: --apply --dry-run writes nothing
- Test: ratchet works with require_langfuse_scores: false

## Success Criteria
- Every LLM call appears as a generation in Langfuse with model, full I/O, token counts, and cost
- Every tool call appears as a span under its parent agent
- Traces have userId, correct environment, release version, and tags
- Trace input is the structured goal, output is a structured result summary
- 5 deterministic scores land on every completed session trace
- LLM-as-judge scores run and produce scores with reasoning
- Persona prompts are versioned in Langfuse prompt registry
- `mae ralph --apply` runs end-to-end with ratchet verification
- No mutation applied without passing golden trace ratchet
- Advisory mode (default) completely unchanged
- All existing tests pass
- System degrades gracefully if Langfuse unreachable

## Execution Strategy

Use subagents to parallelize work and keep the main context window lean. The main thread should orchestrate and verify — not implement.

**Parallel phase groups:**
- Phase 1A-1D (Langfuse sink fixes) can all be developed in one subagent — they're all in langfuse-sink.ts
- Phase 2A (deterministic scores) and Phase 2B (LLM-as-judge) are independent — run in parallel subagents
- Phase 3 (prompt versioning) is independent of Phase 2 — can run in parallel
- Phase 4 (ratchet) depends on Phase 2 scores being available — run after Phase 2 completes
- Phase 5 (CLI + config) depends on Phase 4 — run after
- Phase 6 (tests) — split into two parallel subagents: one for Langfuse sink tests, one for ratchet tests

**Main thread responsibilities:**
1. Plan the phase execution order
2. Spawn subagents for each independent workstream
3. Review subagent output before accepting (read the actual diffs, don't trust summaries)
4. Run `bun test` after each phase merge to catch regressions
5. Integration test: run a real session and verify Langfuse shows generations, scores, userId, etc.

**Rules for subagents:**
- Each subagent gets a single focused file or small set of related files
- Subagent prompt must include the relevant "Current State" context from this goal doc
- Subagents must run `bun test` before reporting done
- Never let two subagents edit the same file concurrently

## Constraints
- Bun + TypeScript only. bun:test for tests.
- Don't modify ralph-evaluator.ts or ralph-evolver.ts
- Don't modify replay.ts scoring logic — use as-is
- All LLM calls go through LiteLLM at 10.71.1.33:4000
- Langfuse at 10.71.20.73:3000 — credentials in Vaultwarden "Langfuse - MAE"
- Structured logging via logger.ts only — no console.log
- Follow existing code patterns in the codebase
- Security: sanitize all inputs sent to Langfuse (no secrets, no env vars, no file paths with sensitive info)
