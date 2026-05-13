# Goal 2: Ralph Verification Ratchet + LLM-as-Judge

> For use with Codex `/goal` command. Created 2026-05-12.
> PREREQUISITE: Goal 1 (Langfuse Data Pipeline) must be complete first.
> Do not start this goal until Langfuse shows real generations, scores, and structured traces.

Build the verification ratchet so `mae ralph --apply` safely auto-applies mutations, verified by deterministic scoring AND LLM-as-judge evals via Langfuse.

## Why This Matters

The Ralph loop already analyzes traces and proposes persona/config mutations — but it's advisory-only because there's no safety net. The ratchet is that safety net: replay golden traces after applying a mutation, score the replay, reject if anything regresses. LLM-as-judge adds qualitative evaluation on top of the deterministic checks.

## Prerequisites (must be true before starting)

Verify these before writing any code:
1. `mae task "create a hello world" --chain build-verify` produces a trace with `llm.call` and `tool.call` events in the local JSONL
2. That same trace appears in Langfuse with at least 1 generation (model + token usage visible)
3. `session_completion` score appears on the trace in Langfuse
4. If any of these fail, STOP — Goal 1 is incomplete

## Current State

### Ralph Loop (DONE — advisory only)
- ralph-loop.ts: Three-population architecture, loads traces, calls evaluator + evolver, returns advisory suggestions
- ralph-evaluator.ts: LLM analyzes traces, returns EvaluatorFinding[] (type, severity, evidence, suggestion)
- ralph-evolver.ts: LLM proposes ConfigMutation[] from findings (target, field, action, content, reasoning)
- `applyMutation()` in ralph-loop.ts is implemented but gated — line 488 says "no files changed"
- Tests: ralph-loop.test.ts (647 lines, 11 suites), replay.test.ts (459 lines, 7 suites)

### Golden Traces (PROBLEM — all failures)
- golden.json has 13 entries, ALL with `"verdict": "fail"`
- Common notes: "recorded zero chain steps", "zero chain steps and one orchestrator-loop error"
- The ratchet needs passing golden traces to verify against — none exist
- This is a cold-start problem that must be addressed

### Replay System (DONE)
- replay.ts: loadTrace, scoreSession (5 deterministic checks), extractFingerprint, compareFingerprints (Jaccard bigram), golden registry
- `mae replay <id>` re-runs a session's goal and compares
- Deterministic checks: session_completed, all_steps_executed, no_agent_failures, no_error_logs, cost_reasonable

### Non-Determinism Reality Check
LLM sessions are inherently non-deterministic. Two runs of the same goal with the same prompt will produce different tool sequences, different agent outputs, different step counts. The ratchet design must account for this:
- Structural fingerprint similarity (Jaccard on bigrams) will naturally vary 20-50% between runs
- Only deterministic features are reliable for regression detection: did it complete? cost within range? errors?
- Behavioral similarity is useful for drift detection, not pass/fail gating

## What to Build

### Phase 1: Golden Trace Bootstrap

Before the ratchet can work, we need passing golden traces.

#### 1A. Fix the golden trace cold-start

Add a `mae golden generate` CLI command that:
1. Runs a set of lightweight test goals across different chains (build-verify, scout-then-plan, review-only)
2. Scores each session using replay.ts
3. If score passes all 5 deterministic checks, auto-adds to golden registry with `verdict: "pass"`
4. If it fails, logs why and skips

Suggested test goals (cheap, fast, verifiable):
```
- "Create a TypeScript function that validates email addresses" (build-verify)
- "What chains are available in this engine?" (scout-then-plan)
- "Review the engine/types.ts file for type safety issues" (review-only)
```

#### 1B. Golden trace quality gate

Add validation to `mae golden add <id>`:
- Refuse to add traces with `verdict: "fail"` unless `--force` flag is passed
- Require at least 1 `llm.call` event in the trace (confirms instrumentation is working)
- Require at least 1 `chain.step.start` event (confirms chain execution is real)
- Show a summary before confirming: events, cost, duration, chain, score

### Phase 2: LLM-as-Judge Scoring

#### 2A. Judge evaluator module (new file: engine/langfuse-judge.ts)

Create a module that:
1. Loads a session trace (local JSONL)
2. Builds a judge prompt with the trace summary: goal, chain, steps, agent outputs, errors, cost
3. Calls the LLM via LiteLLM gateway (engine/llm-gateway.ts) — model depends on context:
   - `main` tier (sonnet) for routine advisory judging
   - `quality` tier (opus) when called from the ratchet for golden trace verification
4. Parses structured response into two scores:
   - `judge_overall_quality` (0.0-1.0): Was the goal achieved? Was output correct?
   - `judge_release_readiness` (0.0-1.0): Production quality? Complete? Handles edge cases?
5. Sends scores to Langfuse via `/api/public/scores` with the judge's reasoning as `comment`
6. Returns the scores for use by the ratchet

**Two-tier judge model strategy:**
- **Sonnet (default)**: Use `main` tier (claude-sonnet-4-6) for routine trace judging during `mae ralph` advisory runs. Fast, cheap, good enough for identifying patterns.
- **Opus (ratchet only)**: Use `quality` tier (claude-opus-4-6) ONLY when the ratchet is making accept/reject decisions on mutations against golden traces. This is the high-stakes decision that justifies the cost.

**Budget controls (CRITICAL):**
- Only judge traces tagged `evaluable: true` or explicitly requested
- Cache: check Langfuse for existing judge scores before re-judging
- Max trace context: truncate to 50 events, prioritizing llm.call and agent.end events
- Per-run cap: judge at most 10 traces per ralph invocation (configurable)
- Skip traces already judged within the last 7 days

#### 2B. Judge prompt design

The judge prompt should include:
```
You are evaluating a multi-agent orchestration session.

Goal: {goal}
Chain: {chain_name}
Duration: {duration_ms}ms
Cost: ${cost_usd}

Steps executed:
{for each chain step: step_name, team, status, duration}

Agent outputs:
{for each agent: persona, grade, output_preview (500 chars)}

Errors:
{list of errors with context}

Rate this session on two dimensions:

1. Overall Quality (0.0-1.0): Did the agents achieve the goal? Is the output correct and useful?
2. Release Readiness (0.0-1.0): Is the output production-quality? Are edge cases handled?

Respond as JSON: { "overall_quality": 0.X, "overall_reasoning": "...", "release_readiness": 0.X, "release_reasoning": "..." }
```

### Phase 3: Verification Ratchet (ralph-loop.ts)

#### 3A. Ratchet implementation

Add a `verifyMutation()` function in ralph-loop.ts that:

1. **Snapshot**: Copy the target file to a temp location
2. **Apply**: Run the existing `applyMutation()` on the real file
3. **Replay**: For each golden trace that involves the affected persona/chain:
   - Load the golden trace to get the original goal
   - Run `mae replay <golden_id>` (or call the replay function directly)
   - Score the replayed session
4. **Compare** — use ONLY deterministic features for pass/fail:
   - `session_completed`: must still be true
   - `no_agent_failures`: must still be true
   - `no_error_logs`: must still be true
   - `cost_reasonable`: must still be true (within 2x of golden cost)
   - If Langfuse judge scores exist on the golden trace, replayed score must not drop more than 0.1
5. **Fingerprint similarity**: Log it for observability but do NOT use it for pass/fail (too noisy due to non-determinism)
6. **Accept/Reject**:
   - ACCEPT: all deterministic checks pass, no judge score regression > 0.1
   - REJECT: restore from snapshot, log why
7. **Minimum coverage**: require at least `min_golden_coverage` golden traces tested. If fewer exist for this persona/chain, REJECT with explanation

#### 3B. Cold-start behavior

When fewer than `min_golden_coverage` passing golden traces exist:
- Log a warning: "Insufficient golden coverage for {persona/chain} — {N} traces, need {min}"
- Still run advisory mode for this mutation (show the suggestion, don't apply)
- Suggest: "Run `mae golden generate` to build baseline golden traces"

#### 3C. Ratchet config

Add to `configs/model-routing.yaml`:
```yaml
ratchet:
  min_golden_coverage: 3
  max_cost_multiplier: 2.0        # replayed session can cost at most 2x the golden
  max_judge_regression: 0.1       # judge score can drop by at most 0.1
  judge_model: main               # sonnet for routine advisory judging
  judge_ratchet_model: quality    # opus ONLY for golden trace ratchet decisions
  judge_max_traces_per_run: 10
  judge_cache_days: 7
  require_langfuse_scores: false  # flip to true once judge pipeline is stable
```

### Phase 4: CLI Integration

#### 4A. `--apply` flag

Modify the ralph CLI handler (cli-commands-ralph.ts):
- `mae ralph` — unchanged, advisory mode
- `mae ralph --apply` — activate ratchet: evaluate → propose → verify → apply-if-safe
- `mae ralph --apply --dry-run` — run ratchet verification but don't write files, show what would happen
- Applied mutations get a git commit: `ralph: {target} {action} (ratchet-verified)`

#### 4B. `mae golden generate`

New CLI command:
- Runs 3-5 lightweight test goals across chains
- Scores each, adds passing ones to golden registry
- Reports: "Generated N golden traces, M failed"

#### 4C. `mae ralph history`

New CLI command:
- Reads `~/.mae/ralph-journal.jsonl`
- Shows: timestamp, mutation target, action, verdict (accept/reject), scores, reasoning
- Supports `--limit N` for recent entries

#### 4D. Mutation journal

Write every ratchet decision to `~/.mae/ralph-journal.jsonl`:
```json
{
  "timestamp": "2026-05-12T10:00:00Z",
  "mutation": { "target": "persona:architect", "field": "system_prompt", "action": "append" },
  "golden_traces_tested": 3,
  "deterministic_scores": { "session_completed": [true, true, true], "cost_reasonable": [true, true, true] },
  "judge_scores": { "overall_quality": [0.85, 0.90, 0.82], "golden_quality": [0.80, 0.85, 0.80] },
  "fingerprint_similarity": [0.72, 0.68, 0.75],
  "verdict": "accept",
  "reasoning": "All deterministic checks pass. Judge scores improved by avg +0.04. Similarity variance within expected non-determinism range."
}
```

### Phase 5: Prompt Versioning

#### 5A. Register prompts on session start

When a session loads agents, for each persona actually used in this session:
- Check Langfuse prompt registry for existing version
- If prompt content changed (hash comparison), create new version
- Store the prompt name + version for use in generation events

Do NOT register all 20 personas on every session — only the ones used.

#### 5B. Link generations to prompt versions

In langfuse-sink.ts, when creating `generation-create` events, add:
- `promptName`: persona name (e.g., "architect")
- `promptVersion`: version from the registry

#### 5C. Ralph mutation → new prompt version

When a Ralph mutation modifies a persona's system_prompt:
- Create a new version in Langfuse prompt registry
- The next session using that persona will automatically link to the new version
- This gives you before/after comparison in Langfuse UI

### Phase 6: Tests

#### Ratchet tests
- Test: `verifyMutation` accepts when all golden replays pass deterministic checks
- Test: `verifyMutation` rejects when any golden replay fails session_completed
- Test: `verifyMutation` rejects when judge score regresses > 0.1
- Test: `verifyMutation` rejects when insufficient golden coverage
- Test: File restored from snapshot on rejection
- Test: Mutation journal entry written on accept
- Test: Mutation journal entry written on reject (with reasoning)
- Test: `--apply --dry-run` runs verification but writes no files and no git commits
- Test: Fingerprint similarity is logged but does NOT affect pass/fail
- Test: Cold-start behavior (< min_golden_coverage) falls back to advisory

#### Judge tests
- Test: Judge prompt built correctly from trace data
- Test: Judge response parsed into two scores
- Test: Budget controls: skips already-judged traces
- Test: Budget controls: respects max_traces_per_run
- Test: Trace truncation to 50 events
- Test: Graceful failure when LLM gateway unreachable

#### Golden bootstrap tests
- Test: `mae golden generate` creates traces and adds passing ones
- Test: `mae golden add` rejects traces with verdict=fail without --force
- Test: `mae golden add` requires llm.call and chain.step.start events

## Execution Strategy

Use subagents. Main thread orchestrates.

**Parallel group 1:**
- Subagent A: Phase 1 (Golden trace bootstrap — CLI command + validation)
- Subagent B: Phase 2 (LLM-as-judge module — new file, no conflicts)

**Sequential gate:** Run `bun test`. Then manually run `mae golden generate` to create baseline goldens.

**Sequential:** Phase 3 (Ratchet) — depends on both Phase 1 (goldens exist) and Phase 2 (judge available)

**Parallel group 2:**
- Subagent C: Phase 4 (CLI integration — cli-commands-ralph.ts)
- Subagent D: Phase 5 (Prompt versioning — langfuse-sink.ts additions)

**Sequential:** Phase 6 tests — split into ratchet tests + judge tests subagents

**Main thread:**
1. Verify Goal 1 prerequisites before starting
2. Spawn subagents per phase
3. Review diffs, run `bun test` between phases
4. Integration test: run `mae ralph --apply --dry-run` on real traces and verify journal output
5. Final test: run `mae ralph --apply` on a real mutation and verify Langfuse shows the new prompt version

## Success Criteria
- `mae golden generate` produces at least 3 passing golden traces
- `mae ralph --apply` runs end-to-end: evaluates → proposes → verifies via ratchet → applies if safe
- No mutation applied without passing golden trace deterministic checks
- LLM-as-judge scores appear in Langfuse with reasoning
- Judge respects budget controls (caching, max traces per run)
- Mutation journal records every accept/reject with full evidence
- Advisory mode (default `mae ralph`) completely unchanged
- Prompt versions tracked in Langfuse, linked to generations
- All existing tests pass
- Ratchet correctly handles non-determinism (doesn't reject valid mutations due to natural LLM variance)

## Constraints
- Bun + TypeScript only. bun:test for tests.
- Don't modify ralph-evaluator.ts or ralph-evolver.ts — they're stable
- Don't modify replay.ts scoring logic — use as-is
- All LLM calls go through the LLM gateway at `MAE_LLM_GATEWAY_URL`
- Langfuse at `LANGFUSE_HOST` — credentials via env vars `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`
- Structured logging via logger.ts only — no console.log
- Follow existing code patterns
- Security: sanitize all inputs (no secrets, no env vars in logs or Langfuse)
- Fingerprint similarity is for observability, NOT pass/fail gating (non-determinism makes it unreliable)
