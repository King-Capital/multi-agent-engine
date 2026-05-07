# Security Reviewer - Attempt 1
Grade: unknown
Cost: $0.0000
Tokens: 0

## Output

All findings confirmed against source. Here's my validation:

---

## Security Reviewer — Validation Report

**File:** `engine/event-emitter.ts` (327 lines)  
**Status:** ✅ All findings verified against source code

---

### Verification Summary

| # | Finding | Line(s) | Verified | Accurate |
|---|---------|---------|----------|----------|
| 1 | Flush deadlock — no try/finally | 62–77 | ✅ | ✅ Confirmed: `this.flushing = false` at L78, no `finally` block. An exception from `JSON.stringify` (circular ref) or network error not caught by `fetchWithRetry` permanently locks the emitter. |
| 2 | Unbounded buffer | 57 | ✅ | ✅ Confirmed: no cap, no `MAX_BUFFER_SIZE`, no overflow logic. `droppedEvents` counter exists (L12) but is only incremented when `fetchWithRetry` returns null — never for buffer overflow. |
| 3 | `res.json()` unguarded | 288 | ✅ | ✅ Confirmed at L288 (`const agent = (await res.json()) as { id?: number }`). Guarded by `res?.ok` check, but `res.ok` doesn't guarantee valid JSON body. An empty 201 or HTML body will throw. |
| 4 | No fetch timeout | 30–44 | ✅ | ✅ Confirmed: no `AbortSignal`, no timeout parameter. A hanging TCP connection blocks flush indefinitely. |
| 5 | Event object mutation | 53 | ✅ | ✅ Confirmed: `(event as SessionEvent & { seq: number }).seq = ++this.seq` mutates caller's object in-place. |
| 6 | Sequential sends, no batching | 64–74 | ✅ | ✅ Confirmed: `for (const event of events)` loop sends one POST per event. |
| 7 | URL path injection | 255, 272, 304 | ✅ | ✅ Confirmed at L255 (`/api/pg/sessions/${sessionId}`), L272 (`/api/pg/sessions/${opts.sessionId}/agents`), L304 (`/api/pg/agents/${pgId}`). No `encodeURIComponent` anywhere in the file. `sessionId` is caller-supplied string — path traversal possible. |
| 8 | Plaintext HTTP token | 15 | ✅ | ✅ Default is `http://localhost:8400`. Bearer token sent on every request via `authHeaders()`. No HTTPS enforcement or warning for remote hosts. |
| 9 | No input sanitization | emit convenience methods | ✅ | ✅ All `content`, `reason`, `task`, `filePath` params go straight to `JSON.stringify` → POST. Stored XSS if dashboard renders unsanitized. |
| 10 | SSRF via `dashboardUrl` | 15 | ✅ | ✅ Constructor accepts arbitrary URL. No validation against private/internal ranges. |
| 11 | Error message info leakage | 74, 241, 260, 292, 309, 324 | ✅ | ✅ `console.error` messages include URL paths, session IDs, agent IDs. |

### Line Number Accuracy Check

The review brief's line references are slightly off from the actual file (likely due to the brief being written against a different version or counting conventions), but every cited code construct exists exactly as described. The logic analysis is correct.

### Grade Validation

**P2 — Needs Fixes Before Production**: ✅ **Agree.**

The combination of the flush deadlock risk (no try/finally), URL path injection (no encoding), and missing fetch timeouts makes this unsuitable for production without fixes. None are actively exploited today (localhost-only, trusted callers), but the code is one bad input or one network hiccup away from a deadlock or security incident.

### Priority Fix Order Validation

The proposed fix order is correct:

1. **try/finally on flush** — Highest impact, easiest fix (2 lines)
2. **encodeURIComponent on URLs** — Direct security fix (3 call sites)
3. **try/catch on res.json()** — Prevents unhandled rejection
4. **AbortSignal.timeout** — Prevents indefinite hang
5. **Buffer cap** — Memory safety
6. **HTTPS warning** — Defense in depth

All recommendations are actionable and correctly scoped. No false positives identified. No findings missed — I checked for additional concerns (prototype pollution via event data, header injection via apiToken, etc.) and found none that weren't already covered.

**Validation verdict: Review is accurate and complete. Approved as-is.**

