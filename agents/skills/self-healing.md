# Self-Healing Escalation

When a worker fails, escalate through progressively more powerful options before giving up.

## Escalation Chain

```
Worker fails (timeout, error, empty response)
  ↓
Retry with SAME worker, MORE context (attempt 2)
  ↓
Replace worker with MORE POWERFUL MODEL (attempt 3)
  ↓
Lead takes over directly (attempt 4 — last resort)
  ↓
Escalate to orchestrator / user
```

## Rules

1. **Attempt 1**: Worker runs normally. If it returns FAILED, empty, or times out → escalate.

2. **Attempt 2**: Same worker, same model. Add the error context and previous output to the prompt. "Your first attempt failed because: [reason]. Try again with this additional context."

3. **Attempt 3**: Replace the worker with a higher-tier model:
   - fast → medium (sonnet low → sonnet medium)
   - medium → high (sonnet medium → opus high)
   - high → different high (opus → gpt-5.5, or vice versa)
   Log: "Escalating [worker] from [old model] to [new model] after 2 failed attempts."

4. **Attempt 4 — Lead self-heal**: The lead breaks its own rules and executes directly.
   Log: "Worker [name] failed after 3 attempts. The task must complete. Let me do this myself."
   The lead uses its read tools + bash (for verification only) to produce the output.
   The lead should do ONLY enough work to unblock progress, then hand back to a worker.

5. **Attempt 5 — Escalate**: If the lead also fails, escalate to the orchestrator.
   Log: "Cannot complete: [task]. Tried: [worker x2, upgraded worker, lead self-heal]. Blocked by: [reason]."
   The orchestrator decides: re-delegate to a different team, or escalate to user.

## Timeout Defaults

| Role | Default Timeout | Max Timeout |
|------|----------------|-------------|
| Scout | 60s | 120s |
| Worker | 300s (5 min) | 600s (10 min) |
| Lead | 600s (10 min) | 900s (15 min) |

## What Counts as Failure

- Process exit code ≠ 0
- Empty output (0 bytes)
- Timeout exceeded
- Grade: FAILED
- Output contains only error messages
