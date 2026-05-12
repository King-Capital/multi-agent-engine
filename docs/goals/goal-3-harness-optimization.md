# Goal 3: Research-Backed Harness Optimization

> For use with Codex `/goal` command. Created 2026-05-12.
> PREREQUISITE: Goal 1 (data pipeline) and Goal 2 (ratchet + judge) should be complete.
> This goal tunes the Ralph loop and MAE's orchestration based on empirical harness engineering research.

Incorporate findings from Stanford's Meta-Harness and Tsinghua's NLAH papers into the Ralph self-improvement loop and MAE's scoring/evaluation framework. The research proves that harness structure matters more than model selection — MAE should optimize for simplicity and token efficiency, not just quality.

## Research Foundation

### Meta-Harness (Stanford, March 2026)
**Paper:** "Meta-Harness: End-to-End Optimization of Model Harnesses"
**Authors:** Yoonho Lee, Roshen Nair, Qizheng Zhang, Kangwook Lee, Omar Khattab, Chelsea Finn
**Link:** https://arxiv.org/abs/2603.28052

Key findings applicable to MAE:
- 6x performance gap from harness changes alone, same model
- Raw execution traces are critical — summarized traces dropped accuracy 50% → 34.9%
- Haiku with auto-optimized harness beat frontier models on TerminalBench-2
- Harness optimized for one model transferred to improve 5 other models
- Converges 10x faster than comparable text optimizers

### Natural-Language Agent Harnesses (Tsinghua, March 2026)
**Paper:** "Natural-Language Agent Harnesses"
**Authors:** Linyue Pan, Lexiao Zou, Shuo Guo, Jingchen Ni, Hai-Tao Zheng
**Link:** https://arxiv.org/abs/2603.25723

Key findings applicable to MAE:
- Migrating control logic from Python to structured natural language: 30.4% → 47.2% on OSWorld
- Self-evolution was the only consistently helpful module (+4.8% SWE-bench)
- Verifier modules HURT performance (-8.4 on OSWorld)
- Multi-candidate search degraded effectiveness (-5.6 points)
- LLM calls collapsed from 1,200 to 34 with natural language harness

## What to Build

### Phase 1: Token Efficiency as a First-Class Metric

The research showed simplified harnesses achieved identical results with 14x fewer tokens. MAE should measure and optimize for this.

#### 1A. Token efficiency score

Add `token_efficiency` to the deterministic scoring pipeline (from Goal 1):
- Compute: `golden_tokens / replayed_tokens` (higher = more efficient)
- Normalize to 0.0-1.0 scale: `min(1.0, golden_tokens / replayed_tokens)`
- Send to Langfuse as a score alongside session_completion, cost_efficiency, etc.
- The ratchet (from Goal 2) should treat token efficiency improvement as a positive signal — mutations that achieve same quality with fewer tokens are preferred

#### 1B. Per-agent token tracking

Currently token counts are aggregated at session level. Break down by agent:
- Track tokens per agent span in Langfuse (generation usage already does this from Goal 1)
- In the Ralph evaluator, flag agents that consume disproportionate tokens relative to their output quality
- Add `high_cost` finding type with token breakdown as evidence

### Phase 2: Subtraction-Aware Ralph Evolver

The research is clear: mature harness engineering is about pruning, not building. The Ralph evolver should be explicitly prompted to propose removals.

#### 2A. Evolver prompt enhancement

Modify the system prompt for ralph-evolver.ts (without changing the module's code — just the prompt content fed to it) to include subtraction guidance:

```
When proposing mutations, apply the subtraction principle:
- Removing unnecessary tools from a persona often improves performance
- Removing verification steps that don't contribute to output quality saves tokens
- Shortening system prompts that contain redundant instructions reduces noise
- Simplifying chain steps (fewer teams, fewer agents) often beats complex orchestration

Research shows: verifier modules reduced performance by -8.4 points, multi-candidate 
search degraded by -5.6 points. More structure is NOT always better.

For each mutation, report whether it adds or removes complexity.
Prefer removals when quality is maintained.
```

#### 2B. Complexity tracking in mutations

Add a `complexity_delta` field to ConfigMutation results:
- `+1` for additions (new tools, longer prompts, extra steps)
- `-1` for removals (tool removal, prompt trimming, step elimination)
- `0` for replacements that don't change complexity

The ratchet should log this alongside quality scores so you can track the correlation between simplification and performance over time.

#### 2C. Tool usage auditing

Add a `mae audit tools` CLI command that:
1. Loads the last N session traces
2. For each persona, counts which tools were available vs actually used
3. Reports tool utilization rates
4. Flags personas with >50% unused tools as candidates for pruning
5. Outputs suggestions in the same format as Ralph mutations

### Phase 3: Raw Trace Mandate

The Meta-Harness paper proved raw traces are irreplaceable: summarized traces degraded accuracy from 50% to 34.9%.

#### 3A. Evaluator trace feeding

Verify that ralph-evaluator.ts feeds raw trace events to the LLM, not summaries. If any preprocessing aggregates or summarizes events before sending to the evaluator, remove it. The evaluator should receive:
- Raw JSONL events (filtered to relevant types: llm.call, agent.start/end, tool.call, chain.step.start/end, errors)
- Truncated to fit context window, but never summarized
- Priority order for truncation: keep errors and agent.end events first, then llm.call, then tool.call

#### 3B. Judge trace feeding

Same principle for the LLM-as-judge (from Goal 2). The judge prompt should receive raw events, not a narrative summary. Truncate by dropping low-signal events (generic `log` type), never by summarizing high-signal events.

#### 3C. Trace size management

For sessions that produce massive traces (>500 events), implement smart truncation:
- Keep ALL error events (never drop these)
- Keep ALL agent.start and agent.end events
- Keep ALL chain.step.start and chain.step.end events
- Sample llm.call events (keep first, last, and every Nth)
- Sample tool.call events (keep failures, sample successes)
- Drop generic `log` events entirely

### Phase 4: Cross-Model Transfer Validation

The Meta-Harness paper showed harness optimizations transfer across models. Test this.

#### 4A. Multi-model ratchet option

Add `--cross-model` flag to `mae ralph --apply`:
- After a mutation passes the primary model ratchet, replay golden traces on a second model tier
- Default: if primary is `main` (Sonnet), verify on `fast` (Haiku) too
- If the mutation improves the primary model but regresses the secondary, flag it (don't auto-reject, but log the divergence)

#### 4B. Cross-model scoring

Store model-specific scores in the mutation journal:
```json
{
  "mutation": "...",
  "scores": {
    "main": { "quality": 0.85, "tokens": 1200 },
    "fast": { "quality": 0.72, "tokens": 800 }
  },
  "transfers": true
}
```

This builds a dataset over time showing which mutations transfer vs which are model-specific.

### Phase 5: Tests

- Test: token_efficiency score computed correctly (golden_tokens / replayed_tokens)
- Test: per-agent token tracking in Langfuse generations
- Test: evolver receives subtraction-aware prompt
- Test: complexity_delta field present on mutations
- Test: tool audit command produces correct utilization rates
- Test: trace truncation preserves all errors and agent events
- Test: trace truncation drops `log` type events first
- Test: cross-model flag triggers replay on secondary model
- Test: mutation journal includes model-specific scores

## Execution Strategy

Less parallel than Goals 1-2 since phases are smaller. Main thread can handle most of this with targeted subagents.

**Parallel group 1:**
- Subagent A: Phase 1 (token efficiency metric + per-agent tracking)
- Subagent B: Phase 2A-2B (evolver prompt + complexity tracking)

**Sequential:** Phase 2C (tool audit CLI) — small, do in main thread

**Parallel group 2:**
- Subagent C: Phase 3 (raw trace mandate — verify evaluator + judge + add truncation)
- Subagent D: Phase 4 (cross-model transfer)

**Sequential:** Phase 5 tests

## Success Criteria
- Token efficiency score appears on every session trace in Langfuse
- Ralph evolver proposes removals (not just additions) when quality is maintained
- Mutations include complexity_delta field
- `mae audit tools` identifies underutilized tools per persona
- Evaluator and judge receive raw trace events, never summaries
- Smart truncation preserves errors and agent events, drops noise
- Cross-model validation logged in mutation journal
- Existing tests unbroken

## Constraints
- Bun + TypeScript only. bun:test for tests.
- Don't modify ralph-evaluator.ts or ralph-evolver.ts code — only modify the prompt content they receive
- Don't modify replay.ts scoring logic
- Follow existing code patterns
- Structured logging via logger.ts only

## References
- Meta-Harness paper: https://arxiv.org/abs/2603.28052
- NLAH paper: https://arxiv.org/abs/2603.25723
- MindStudio synthesis: https://www.mindstudio.ai/blog/omar-khattab-dspy-auto-optimized-harness-haiku-terminalbench
