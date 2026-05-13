# Goal 1: Langfuse Data Pipeline — Make Traces Real

> For use with Codex `/goal` command. Created 2026-05-12.
> Prerequisite for Goal 2 (Ralph ratchet + LLM-as-judge). Ship this first.

Fix the broken data pipeline so every MAE session produces rich, queryable traces in Langfuse with generations, token usage, costs, tool calls, scores, and proper metadata.

## Why This Matters

The Ralph self-improvement loop, LLM-as-judge evals, and prompt versioning all depend on trace data existing in Langfuse. Right now it doesn't. The sink creates skeleton traces but misses everything that makes them useful. This goal fixes the data layer so Goal 2 can build on real signal.

## Current State (verified by live inspection)

### What the Langfuse sink currently produces
- Session-level trace with weak metadata ✓
- Agent/team/worker/review delegation spans ✓
- Status transition and error events ✓

### What's broken (10 specific gaps)

1. **No generations** — Zero `generation-create` events. LLM calls are invisible in Langfuse.
2. **No scores** — 7 score configs provisioned (langfuse-admin.ts) but scores never computed or sent.
3. **No userId** — `trace-create` (langfuse-sink.ts:52) never sets `userId`.
4. **Environment always "default"** — No `environment` or `release` field on any event.
5. **No input** — Trace input is `entry.task_preview ?? entry.goal`, often undefined.
6. **Output is weak** — Hardcoded string: `"Status: ${status}, Cost: $${cost}"` (line 72).
7. **No token usage or costs** — No `usage` object on any event. No `calculatedTotalCost`.
8. **Tool calls invisible** — `tool.call` events in local JSONL but never sent to Langfuse.
9. **No prompt versioning** — Persona prompts not linked to Langfuse prompt objects.
10. **Span I/O empty** — Agent spans have truncated input preview, never have output.

### Root cause (CRITICAL — this is not just a sink problem)

The data doesn't exist in the logging pipeline. The adapters never emit structured log entries:

- **Pi adapter** (`engine/adapters/pi.ts`): `processRpcEvent()` (line 391-461) receives rich data — tool calls with args, `message_end` events with `usage.inputTokens`, `usage.outputTokens`, `usage.cost.total`, `usage.cacheRead` — but routes it ONLY to `onStreamEvent` (dashboard). It never calls `log.info()` with these fields. The only log calls are "Spawning pi-rpc agent" (line 112) and error cases.
- **Echo adapter**: Returns hardcoded mock data (`costUsd: 0.001, tokensUsed: 100`).
- **A2A adapter**: Polls task status but never reports token usage.
- **Real trace files**: `session-1.jsonl` has 189 events — 188 are generic `log` type, 1 is `session.start`. Zero `llm.call`, zero `tool.call`, zero `agent.start/end`, zero `chain.step.start/end`.

The trace-recorder (engine/trace-recorder.ts) has extraction logic for `llm.call` events (lines 185-190) that maps `prompt_tokens`, `completion_tokens`, `model`, `cost` — but this code never fires because no adapter emits log entries with those fields.

**Bottom line: the sink can't send data to Langfuse that never enters the logging pipeline.**

### Infrastructure
- Langfuse v3 at `LANGFUSE_HOST` (running)
- LLM gateway at `MAE_LLM_GATEWAY_URL`
- Score configs provisioned: session_completion, agent_grade, cost_efficiency, worker_success_rate, chain_step_completion, judge_overall_quality, judge_release_readiness
- VERSION file at repo root for release tagging

## What to Build

### Phase 1: Adapter Instrumentation (the actual fix)

The Pi adapter already receives all the data via RPC events — it just doesn't log it. Add structured log calls alongside the existing `onStreamEvent` calls.

#### 1A. Pi adapter: LLM call logging (engine/adapters/pi.ts)

In `processRpcEvent()`, when `evt.type === "message_end"` and usage data is present (line 435-460), add:

```typescript
log.info("LLM call completed", {
  trace_type: "llm.call",
  agent_id: agentId,   // need to pass agentId into processRpcEvent
  model: (msg as Record<string, unknown>).model ?? opts.model,
  prompt_tokens: (usage.inputTokens as number) ?? (usage.input_tokens as number) ?? 0,
  completion_tokens: (usage.outputTokens as number) ?? (usage.output_tokens as number) ?? 0,
  cache_read_tokens: cache,
  total_tokens: tokens,
  cost: finalCost,
  duration_ms: undefined,  // not available per-message; OK to omit
  persona: opts.persona.name,
  team: opts.team,
});
```

This requires passing `agentId`, `opts.persona.name`, and `opts.team` into `processRpcEvent`. Change the method signature to accept a context object:
```typescript
private processRpcEvent(
  evt: Record<string, unknown>,
  onStream: ((event: StreamEvent) => void) | undefined,
  onCost: (cost: number, tokens: number, cacheRead: number) => void,
  context: { agentId: string; persona: string; team?: string; model: string },
): void {
```

Update the call site at line 225 to pass context.

#### 1B. Pi adapter: Tool call logging (engine/adapters/pi.ts)

In `processRpcEvent()`, when `evt.type === "tool_execution_start"` (line 399-418), add:

```typescript
log.info("Tool call", {
  trace_type: "tool.call",
  agent_id: context.agentId,
  tool: toolName,
  args_preview: filePath || toolArgs?.slice(0, 200),
});
```

When `evt.type === "tool_execution_end"` (already handled in delegate() at line 231-245), add:

```typescript
log.info("Tool call completed", {
  trace_type: "tool.call",
  agent_id: agentId,
  tool: toolName,
  success: !isError,
  output_preview: toolResult?.slice(0, 500),
});
```

#### 1C. Pi adapter: Agent lifecycle logging

At agent spawn (line 112, already exists but missing fields):
```typescript
log.info("Spawning pi-rpc agent", {
  trace_type: "agent.start",     // ADD this field
  agent_id: agentId,
  model: piModel,
  persona: opts.persona.name,    // ADD
  team: opts.team,               // ADD
  role: opts.persona.role,       // ADD
  skills: opts.persona.skills.length,
  working_dir: opts.workingDir,
  system_prompt_length: opts.persona.systemPrompt?.length ?? 0,  // ADD
});
```

At agent completion (around line 274, in safeResolve after agent_end):
```typescript
log.info("Agent completed", {
  trace_type: "agent.end",
  agent_id: agentId,
  persona: opts.persona.name,
  team: opts.team,
  grade: this.extractGrade(finalText),
  cost: totalCost,
  tokens: totalTokens,
  output_preview: finalText?.slice(0, 500),
});
```

#### 1D. Echo adapter: Match the same logging pattern

The echo adapter is used for testing. It should emit the same `trace_type` fields so tests produce realistic traces. Add `log.info` calls for `agent.start`, `agent.end`, `llm.call` with the mock data it already has.

#### 1E. A2A adapter: Best-effort logging

The A2A adapter delegates to external services that may not report token usage. Log what's available:
- `agent.start` when task is created
- `agent.end` when task completes with status and any available cost/token data
- If the A2A service doesn't report tokens, log with `tokens: 0` — don't fake it

### Phase 2: Langfuse Sink Enrichment (langfuse-sink.ts)

Now that the adapters emit structured events, wire them into Langfuse.

#### 2A. Trace metadata

On `trace-create` (line 52), add these fields to the body:
- `userId`: `entry.user_id ?? entry.initiator ?? "mae-engine"`
- `release`: read VERSION file content at module load (e.g., "1.0.4")
- `environment`: `process.env.MAE_ENV ?? "development"`
- `tags`: `[entry.chain, entry.adapter].filter(Boolean)`
- `input`: `{ goal: entry.goal ?? entry.name ?? "unknown", task: entry.task, chain: entry.chain }`

On session end `trace-create` (line 69), replace the string output:
```typescript
output: {
  status: entry.status,
  cost_usd: entry.cost_usd ?? entry.total_cost ?? 0,
  duration_ms: entry.duration_ms,
  steps_completed: entry.steps_completed,
  steps_total: entry.steps_total,
  agents_used: entry.agents_used,
  errors: entry.error_count ?? 0,
},
```

#### 2B. Generation tracking

Add state tracking at the top of the sink:
```typescript
const agentSpanIds = new Map<string, string>();  // agent_id → Langfuse spanId
```

When creating agent delegation spans (line 83-101), store the spanId:
```typescript
const spanId = uid();
if (entry.agent_id) agentSpanIds.set(entry.agent_id as string, spanId);
```

Add a new handler for `trace_type === "llm.call"` entries:
```typescript
if (entry.trace_type === "llm.call" && currentTraceId) {
  const genId = uid();
  const agentId = entry.agent_id as string | undefined;
  buffer.push({
    id: genId, type: "generation-create", timestamp: entry.ts,
    body: {
      id: genId,
      traceId: currentTraceId,
      parentObservationId: agentId ? agentSpanIds.get(agentId) : undefined,
      name: `${entry.persona ?? entry.agent_id ?? "llm"}`,
      model: entry.model,
      usage: {
        promptTokens: entry.prompt_tokens,
        completionTokens: entry.completion_tokens,
        totalTokens: entry.total_tokens ?? ((entry.prompt_tokens ?? 0) + (entry.completion_tokens ?? 0)),
      },
      metadata: {
        agent_id: agentId,
        team: entry.team,
        cost_usd: entry.cost,
        cache_read_tokens: entry.cache_read_tokens,
      },
    },
  });
  ensureTimer();
  return;
}
```

#### 2C. Tool call spans

Add handler for `trace_type === "tool.call"` entries:
```typescript
if (entry.trace_type === "tool.call" && currentTraceId) {
  const spanId = uid();
  const agentId = entry.agent_id as string | undefined;
  buffer.push({
    id: spanId, type: "span-create", timestamp: entry.ts,
    body: {
      id: spanId,
      traceId: currentTraceId,
      parentObservationId: agentId ? agentSpanIds.get(agentId) : undefined,
      name: `tool/${entry.tool ?? "unknown"}`,
      input: entry.args_preview,
      output: entry.output_preview,
      metadata: { success: entry.success, exit_code: entry.exit_code },
    },
  });
  ensureTimer();
  return;
}
```

#### 2D. Span completion (update with output + endTime)

Add handler for `trace_type === "agent.end"` entries:
```typescript
if (entry.trace_type === "agent.end" && currentTraceId) {
  const agentId = entry.agent_id as string | undefined;
  const existingSpanId = agentId ? agentSpanIds.get(agentId) : undefined;
  if (existingSpanId) {
    buffer.push({
      id: uid(), type: "span-update", timestamp: entry.ts,
      body: {
        id: existingSpanId,
        traceId: currentTraceId,
        endTime: entry.ts,
        output: {
          grade: entry.grade,
          output_preview: entry.output_preview,
          cost_usd: entry.cost,
          tokens: entry.tokens,
        },
      },
    });
    agentSpanIds.delete(agentId!);
    ensureTimer();
  }
  return;
}
```

### Phase 3: Deterministic Scores

After session ends, compute and send scores to Langfuse. Add a `computeAndSendScores()` function called from the session-end handler.

Scores to compute and POST to `/api/public/scores`:
- `session_completion`: 1.0 if status=completed, 0.5 if partial, 0.0 if error/timeout
- `cost_efficiency`: `1.0 - (cost / budget_limit)`, clamped 0-1
- `worker_success_rate`: successful_workers / total_workers (if available from entry)
- `chain_step_completion`: completed_steps / total_steps (if available)

Each score POST:
```typescript
await fetch(`${host}/api/public/scores`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
  body: JSON.stringify({
    name: scoreName,
    traceId: currentTraceId,
    value: scoreValue,
    comment: scoreReasoning,
  }),
});
```

Score computation must be best-effort — if fields are missing, skip that score rather than sending 0.

### Phase 4: Tests

#### Adapter instrumentation tests
- Test: Pi adapter `processRpcEvent` emits `log.info` with `trace_type: "llm.call"` on message_end events
- Test: Pi adapter emits `trace_type: "tool.call"` on tool_execution_start/end
- Test: Pi adapter emits `trace_type: "agent.start"` and `trace_type: "agent.end"` with correct fields
- Test: Echo adapter emits matching trace_type events
- Test: Token counts and cost in log entries match what processRpcEvent receives

#### Langfuse sink tests
- Test: `generation-create` events emitted when sink receives `llm.call` log entries
- Test: `generation-create` includes usage object with promptTokens, completionTokens, totalTokens
- Test: `span-create` for tool calls with parent observation linking
- Test: `span-update` sent on agent.end with output and endTime
- Test: `trace-create` includes userId, environment, release, tags
- Test: Trace output is structured object, not string template
- Test: `agentSpanIds` map correctly tracks concurrent agents
- Test: Graceful degradation when Langfuse is unreachable (no crash, events dropped silently)

#### Score tests
- Test: session_completion score sent after session ends
- Test: cost_efficiency computed correctly
- Test: Missing fields skip the score rather than sending 0
- Test: Score POST failures don't crash the sink

#### Integration verification
After all phases: run a real session (`mae task "create a hello world function" --chain build-verify`) and verify in Langfuse UI:
- Trace has userId, environment, release
- At least 1 generation with model, token counts, cost
- Tool call spans nested under agent spans
- session_completion score attached
- Structured output on trace

## Execution Strategy

Use subagents to parallelize. Main thread orchestrates and verifies.

**Parallel group 1:**
- Subagent A: Phase 1A-1C (Pi adapter instrumentation) — single file: `engine/adapters/pi.ts`
- Subagent B: Phase 1D-1E (Echo + A2A adapter instrumentation) — two files, independent

**Sequential gate:** Run `bun test` after Phase 1 merges. Adapters must emit correct log entries before Phase 2 starts.

**Parallel group 2:**
- Subagent C: Phase 2A-2D (Langfuse sink enrichment) — single file: `engine/langfuse-sink.ts`
- Subagent D: Phase 3 (Deterministic scores) — can be a new file or added to langfuse-sink.ts

**Sequential gate:** Run `bun test` after Phase 2+3 merge.

**Parallel group 3:**
- Subagent E: Phase 4 adapter tests
- Subagent F: Phase 4 sink + score tests

**Main thread responsibilities:**
1. Plan phase execution, spawn subagents
2. Review actual diffs (don't trust summaries)
3. Run `bun test` between phase groups
4. Run integration verification at the end
5. Never let two subagents edit the same file

## Success Criteria
- Real trace files contain `llm.call`, `tool.call`, `agent.start`, `agent.end` events (not just `log`)
- Every LLM call appears as a generation in Langfuse with model, token counts
- Every tool call appears as a span under its parent agent
- Traces have userId, correct environment, release version, tags
- Trace input is structured goal, output is structured result summary
- At least session_completion score lands on every completed session
- All existing tests pass
- Sink degrades gracefully if Langfuse is unreachable

## Constraints
- Bun + TypeScript only. bun:test for tests.
- All LLM calls go through the LLM gateway at `MAE_LLM_GATEWAY_URL`
- Langfuse at `LANGFUSE_HOST` — credentials via env vars `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`
- Structured logging via logger.ts only — no console.log
- Don't change the trace-recorder.ts mapping logic — it's correct, it just needs data
- Don't change any adapter's external behavior (DelegateResult shape, stream events) — only add logging
- Security: sanitize all inputs before logging (no secrets, no full file contents, no env vars)
- Follow existing code patterns
