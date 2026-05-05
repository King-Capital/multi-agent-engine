# Validation Lead - Attempt 1
Grade: unknown
Cost: $0.1190
Tokens: 1587

## Output

I now have a thorough understanding of the full implementation. Let me conduct both reviews myself since I don't have delegate tools — I'll execute both the Code Review and Security Review.

---

## Validation Report: `engine/self-healing.ts`

### TillDone: self-healing.ts validation [3/3]
- [x] Code reviewed
- [x] Security checked
- [x] Grade assigned

---

### Code Review (P0–P3 findings)

**P1 — Attempt count promise vs. reality (off-by-one logic)**
The function claims `maxAttempts = 4` but never uses that constant. The actual attempt count is hardcoded via the sequential if-blocks (1, 2, 3). Attempt 4 is a comment saying "handled by the orchestrator." The `maxAttempts` variable is dead code and misleading — someone reading it would expect a loop up to 4.

**P1 — When model doesn't escalate, attempt 3 is silently skipped**
If `MODEL_ESCALATION[opts.model]` returns the same model (doesn't exist in the map), `modelChanged = false` and the entire attempt 3 block is skipped. The function jumps straight from attempt 2 failure to the final escalation. The log says `"All 2 attempts failed"` which is correct, but the function advertises `maxAttempts = 4` and the caller has no visibility into *why* only 2 attempts were made. This is a correctness gap for models not in the escalation map (e.g., `litellm/opus-nocache` has no escalation target — it's the top of the chain, so the agent only gets 2 tries).

**P1 — `retryPrompt` is reused for attempt 3 but references attempt 1's failure**
The `retryPrompt` is built once after attempt 1 fails, then reused in attempt 3. But by attempt 3, we have attempt 2's failure context too. The agent escalated to a better model but is told about attempt 1's failure, not attempt 2's. This means the upgraded model doesn't benefit from the latest failure information.

**P2 — Mutation of caller's `opts` object**
Line `opts.timeoutMs = opts.timeoutMs ?? TIMEOUT_FOR_ROLE[agentRole] ?? 300_000;` mutates the passed-in options object. The orchestrator's `delegateOpts` object is modified in place. This could cause subtle bugs if the same options object were ever reused (it isn't currently, but it's a latent defect).

**P2 — `isFailed()` checks are fragile**
- `result.output.startsWith("ERROR:")` — depends on adapters consistently using this prefix. No contract enforces this.
- `result.findings?.includes("timeout")` — substring match on findings array. If a finding says "no timeout occurred" it would false-positive as failed.
- Empty output (`!result.output.trim()`) is a heuristic, not all empty outputs are failures (e.g., a "delete this file" task might produce empty output).

**P2 — `logOutput` swallows all errors silently**
The catch block catches *everything* (not just missing session dir). Disk-full errors, permission errors, encoding errors — all silently swallowed. Should at least `console.warn`.

**P3 — `costUsd.toFixed(4)` in logOutput assumes costUsd is always a number**
If `costUsd` is `undefined` or `NaN` (from a failed adapter), `.toFixed()` will throw or produce `"NaN"`.

**P3 — No budget guard**
`delegateWithHealing` can retry up to 3 times (including model escalation to opus) with no cost budget check. The model-routing config defines `max_per_agent_usd: 15.00` but this function doesn't enforce it. The healing retries could blow past the per-agent budget, especially after escalating to opus.

---

### Security Review

**P1 — No input sanitization on retry prompt injection**
The `retryPrompt` includes `result.output.slice(0, 1000)` — raw output from the previous failed attempt. If a malicious or compromised adapter injects prompt-injection payloads into `result.output`, those payloads are fed directly back to the next attempt as part of the prompt. The orchestrator calls `sanitizeAgentInput()` on initial prompts, but `delegateWithHealing` does NOT sanitize the retry prompt containing previous output. This is a **prompt injection amplification vector**.

**P2 — Model escalation map is hardcoded, not validated against config**
`MODEL_ESCALATION` maps model names as literal strings, but the canonical model routing is in `configs/model-routing.yaml`. If someone changes the model aliases in the YAML, the escalation map becomes stale. An attacker who can modify the config could redirect the escalation to a weaker model. The escalation map mixes aliases (`"fast"`, `"main"`) with resolved model names (`"litellm/sonnet-nocache"`) — if `resolveModel()` is called on an alias before passing to this function, the alias-based entries will never match.

**P2 — `logOutput` writes to filesystem with agent-controlled data**
The `agentName` from the persona config is used to build the file path via slug. If a persona name contained path traversal characters (e.g., `../../etc/cron`), the slug construction (`toLowerCase().replace(/\s+/g, "-")`) does NOT strip `/` or `..`. This allows directory traversal in the log write path. Example: persona name `"../../../tmp/evil"` → slug `"../../../tmp/evil"` → writes outside session dir.

**P3 — No output size limit on retry context**  
`result.output.slice(0, 1000)` caps at 1000 chars for the retry prompt, which is reasonable. But `logOutput` writes the full `result.output` with no size cap. A malicious adapter returning megabytes of output would create oversized log files.

**P3 — `writeFileSync` with no mode restriction**
Log files are created with default permissions (typically 0o666 minus umask). In multi-user environments, these could be world-readable, potentially leaking agent output.

---

### Grade: **PARTIAL**

The self-healing mechanism works for the happy path but has meaningful correctness gaps (stale retry context, opts mutation, inconsistent attempt counting) and a security gap (unsanitized previous output fed back as prompt). The path traversal in `logOutput` is a real vulnerability if persona names aren't validated upstream.

**Recommended fixes (priority order):**
1. Sanitize `result.output` before including in retry prompts (use `sanitizeAgentInput`)
2. Validate/sanitize the slug in `logOutput` against path traversal
3. Rebuild `retryPrompt` for attempt 3 with attempt 2's failure context
4. Clone `opts` instead of mutating the caller's object
5. Remove the dead `maxAttempts` constant or implement a proper retry loop
6. Add budget checks before escalation retries


