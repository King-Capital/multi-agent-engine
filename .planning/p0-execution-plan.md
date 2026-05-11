# P0 Execution Plan — Agent-Ready

> Each section is a self-contained agent prompt. Hand it to an agent, let it run, then verify with the checklist.

## Agent A: Security Module (Issues #200 + #204)

### Prompt

```
You are fixing two security issues in the Multi-Agent Engine at /Volumes/ThunderBolt/Development/ai-agents/platforms/multi-agent-engine/

ISSUE #200 — security.ts:279 fails open

File: engine/security.ts, line 279
Current: `catch { return true; }`
Fix: `catch { return false; }`

A security function that validates URLs catches all errors and returns `true` (allow). This means malformed URLs bypass security checks. Change it to return `false` (deny).

ISSUE #204 — Security module dead code

File: engine/security.ts

These 5 functions are defined but NEVER called anywhere in the codebase:
- checkBashCommand()
- checkFileAccess()
- checkConfigMutation()
- verifyPersonaIntegrity() + registerPersonaHash()
- validateAgentOutput()

Verify they are unused: grep -r "checkBashCommand\|checkFileAccess\|checkConfigMutation\|verifyPersonaIntegrity\|registerPersonaHash\|validateAgentOutput" engine/ --include="*.ts" -l

If grep confirms they are only in security.ts (definition) and nowhere else:
1. Remove all 5 unused functions
2. Remove the damage-control-rules.yaml loading if nothing references it after cleanup
3. Keep ONLY: sanitizeAgentInput() (used), isInternalUrl() (used), and any types/imports they need
4. Add a comment at the top: "// Security enforcement is delegated to adapter extensions (Pi tool_call interception). This module provides input sanitization only."

After changes:
- Run: bun tsc --noEmit (must pass)
- Run: bun test (must pass)
- Run: grep -r "checkBashCommand\|checkFileAccess\|checkConfigMutation\|verifyPersonaIntegrity\|validateAgentOutput" engine/ --include="*.ts" (should return nothing outside security.ts)

Commit message: "fix(security): fail closed on URL parse error, remove dead security functions (#200, #204)"
```

### Verification Checklist

```bash
# 1. isInternalUrl fails closed
grep -A1 "catch" engine/security.ts | grep "return false"

# 2. Dead functions removed
for fn in checkBashCommand checkFileAccess checkConfigMutation verifyPersonaIntegrity registerPersonaHash validateAgentOutput; do
  count=$(grep -r "$fn" engine/ --include="*.ts" | grep -v "test" | wc -l)
  echo "$fn: $count references (should be 0)"
done

# 3. Used functions still exist
grep "export function sanitizeAgentInput" engine/security.ts && echo "OK" || echo "MISSING"
grep "export function isInternalUrl" engine/security.ts && echo "OK" || echo "MISSING"

# 4. Compiles
bun tsc --noEmit 2>&1 | tail -3

# 5. Tests pass
bun test 2>&1 | tail -5
```

---

## Agent B: Pi Adapter (Issues #201 + #202 + #210)

### Prompt

```
You are fixing three bugs in the Pi adapter at /Volumes/ThunderBolt/Development/ai-agents/platforms/multi-agent-engine/

Read engine/adapters/pi.ts first.

ISSUE #201 — 3 dangerous silent catches

Replace these bare catch {} blocks with error logging:

1. Line ~261 (JSON parse in stream loop):
   Current: catch {}
   Fix: catch (e) { console.error(`[pi-adapter:${agentId}] Failed to parse RPC line:`, line?.slice(0, 200), e); }

2. Line ~266 (entire processStream outer try):
   Current: catch {}
   Fix: catch (e) { console.error(`[pi-adapter:${agentId}] Stream processing error:`, e); }

3. Line ~361 (sendCmd stdin write):
   Current: catch {}
   Fix: catch (e) { console.error(`[pi-adapter:${agentId}] sendCmd failed — agent may not have received the message:`, e); }

ISSUE #202 — proc.stderr consumed twice

The bug: proc.stderr is a ReadableStream read at two locations (~line 272 and ~line 324). A ReadableStream can only be consumed once. The second read always gets empty string.

Fix: Buffer stderr once at process spawn, reference the buffer everywhere.

After spawning the process (around line 87), add:
```typescript
let stderrText = "";
const stderrPromise = new Response(proc.stderr).text().then(t => { stderrText = t; }).catch(() => {});
```

Then replace BOTH stderr reads:
- Line ~272: replace `const stderr = await new Response(proc.stderr).text();` with `await stderrPromise; const stderr = stderrText;`
- Line ~324: replace `const stderr = await new Response(proc.stderr).text().catch(() => "");` with `const stderr = stderrText;`

ISSUE #210 — Full environment leaked to subprocess

At line ~133, the adapter passes the entire process environment to the Pi subprocess (minus MAE_API_TOKEN). This leaks ANTHROPIC_API_KEY, OPENAI_API_KEY, and other secrets.

Fix: Replace the env construction with an allowlist:

```typescript
env: {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  SHELL: process.env.SHELL,
  TERM: process.env.TERM,
  LANG: process.env.LANG,
  USER: process.env.USER,
  TMPDIR: process.env.TMPDIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  // LiteLLM proxy — agents call LiteLLM, not providers directly
  LITELLM_API_BASE: process.env.LITELLM_API_BASE,
  LITELLM_API_KEY: process.env.LITELLM_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, // Pi needs this for direct Anthropic calls
  // MAE context
  MAE_SESSION_ID: opts.session?.id ?? "",
  MAE_AGENT_ID: agentId,
  MAE_DASHBOARD_URL: process.env.MAE_DASHBOARD_URL ?? "",
},
```

After changes:
- Run: bun tsc --noEmit (must pass)
- Run: bun test (must pass)
- Verify no bare catch {} on critical path: grep -n "catch {}" engine/adapters/pi.ts

Commit message: "fix(pi-adapter): log silent catches, fix double stderr read, allowlist subprocess env (#201, #202, #210)"
```

### Verification Checklist

```bash
# 1. No bare catch {} on critical path (lines 261, 266, 361)
grep -n "catch {}" engine/adapters/pi.ts
# Should only show process cleanup catches (kill, reader.cancel, stdin.end) — NOT stream/parse/sendCmd

# 2. stderr buffered once
grep -c "new Response(proc.stderr)" engine/adapters/pi.ts
# Should be 1 (the single buffer), not 2

# 3. Env is allowlisted (no spread of process.env)
grep "\.\.\.safeEnv\|\.\.\.process\.env" engine/adapters/pi.ts
# Should return nothing

# 4. Key secrets NOT in env
grep "OPENAI_API_KEY\|PVE_TOKEN\|DATABASE_URL" engine/adapters/pi.ts
# Should return nothing (these should NOT be in the allowlist)

# 5. Compiles
bun tsc --noEmit 2>&1 | tail -3

# 6. Tests pass
bun test 2>&1 | tail -5
```

---

## Agent C: Budget Silent Disable (Issue #203)

### Prompt

```
You are fixing a critical bug in the Multi-Agent Engine at /Volumes/ThunderBolt/Development/ai-agents/platforms/multi-agent-engine/

Read engine/budget.ts first.

ISSUE #203 — budget.ts:39 silently disables all budget enforcement

At approximately line 39, the loadBudgets() function has a bare catch {} that returns { budgets: null }. When budgets is null, checkBudget() at line ~93 skips ALL checks. This means a transient filesystem error silently removes all cost controls for the entire session.

Fix:

1. Add a CRITICAL-level log in the catch block:
```typescript
catch (err) {
  console.error("[budget] CRITICAL: Failed to load model-routing.yaml — applying safe defaults:", err);
  return {
    budgets: { session: 50.0, project: 500.0 },
    budgetWarned: false
  };
}
```

2. Also add a test file engine/budget.test.ts (or add to existing test file):
```typescript
import { describe, it, expect, mock } from "bun:test";
// Test that loadBudgets returns safe defaults when config is unreadable
// Test that checkBudget does NOT skip when budgets has safe defaults
```

After changes:
- Run: bun tsc --noEmit (must pass)
- Run: bun test (must pass)
- Verify: grep "CRITICAL" engine/budget.ts (should find the new log line)

Commit message: "fix(budget): fail closed with safe defaults when config unreadable (#203)"
```

### Verification Checklist

```bash
# 1. No bare catch {} in loadBudgets
grep -A3 "catch" engine/budget.ts | head -10
# Should show error logging, not bare catch

# 2. Safe defaults applied
grep "session:" engine/budget.ts | grep -v "//"
# Should show a numeric default (e.g., 50.0)

# 3. CRITICAL log present
grep "CRITICAL" engine/budget.ts
# Should find the warning message

# 4. Test exists
ls engine/budget.test.ts 2>/dev/null || ls engine/__tests__/budget* 2>/dev/null
# Should find a test file

# 5. Compiles
bun tsc --noEmit 2>&1 | tail -3

# 6. Tests pass
bun test 2>&1 | tail -5
```

---

## Post-Agent Verification (Run After All 3 Complete)

```bash
cd /Volumes/ThunderBolt/Development/ai-agents/platforms/multi-agent-engine

# Full test suite
bun test 2>&1 | tail -10

# Type check
bun tsc --noEmit 2>&1 | tail -5

# Verify all P0 fixes are present
echo "=== P0 Verification ==="

echo "1. isInternalUrl fails closed:"
grep -A1 "catch" engine/security.ts | grep -q "return false" && echo "  PASS" || echo "  FAIL"

echo "2. Dead security functions removed:"
for fn in checkBashCommand checkFileAccess checkConfigMutation; do
  grep -rq "$fn" engine/ --include="*.ts" && echo "  FAIL: $fn still exists" || echo "  PASS: $fn removed"
done

echo "3. Pi adapter — no silent catches on critical path:"
critical_catches=$(grep -n "catch {}" engine/adapters/pi.ts | grep -v "kill\|cancel\|end\|stdin" | wc -l)
[ "$critical_catches" -eq 0 ] && echo "  PASS" || echo "  FAIL: $critical_catches silent catches remain"

echo "4. Pi adapter — stderr buffered once:"
stderr_reads=$(grep -c "new Response(proc.stderr)" engine/adapters/pi.ts)
[ "$stderr_reads" -le 1 ] && echo "  PASS ($stderr_reads reads)" || echo "  FAIL: $stderr_reads reads (should be 1)"

echo "5. Pi adapter — env allowlisted:"
grep -q "\.\.\.safeEnv\|\.\.\.process\.env" engine/adapters/pi.ts && echo "  FAIL: process.env still spread" || echo "  PASS"

echo "6. Budget — safe defaults on failure:"
grep -q "CRITICAL" engine/budget.ts && echo "  PASS" || echo "  FAIL: no CRITICAL log"

echo "=== Done ==="
```

## Git Workflow

After all agents complete and verification passes:

```bash
# Check each agent's branch/changes
git diff --stat

# If using worktrees, merge each branch
# If on same branch, review the combined diff

# Push to trigger CI
git push origin main

# Watch deploy
gh run list --workflow "Deploy Engine" --limit 1
```
