# Security Reviewer - Attempt 1
Grade: unknown
Cost: $0.0000
Tokens: 15619

## Output

---

# OWASP Security Review: `GET /api/sessions/stats`

## 1. Authentication — ✅ PASS (No findings)

**Analysis:** The `authMiddleware` (lines 353–396) evaluates the request path against a public whitelist:

```go
isPublicAPI := path == "/api/health" || path == "/api/users" || strings.HasSuffix(path, "/stream")
```

`/api/sessions/stats` does **not** match any of these conditions:
- Not `/api/health` ✗
- Not `/api/users` ✗
- Does not end with `/stream` ✗

Therefore, a `GET` to `/api/sessions/stats` falls through to the Bearer token check. Without a valid token, the middleware returns `401 Unauthorized` or `503 Service Unavailable` (if DB is offline and `tokenMap` is empty — fail-closed behavior).

**Verdict:** Correctly requires authentication. This is the right design — stats expose cost/token data which should not be public. Consistent with sibling endpoint `GET /api/sessions` which has the same auth requirement.

## 2. Information Disclosure — **P3 (Low / Informational)**

**Exposed data:**
| Field | Source | Risk |
|---|---|---|
| `total_sessions` | Count of `s.sessions` | Low — aggregate count only |
| `total_cost` | Sum of `sess.TotalCost` (USD) | Low — aggregate, no per-session breakdown |
| `total_tokens` | Sum of `sess.TotalTokens` | Low — aggregate |
| `sessions_by_chain` | Map of `sess.ChainType → count` | **See below** |

**`ChainType` key leakage:** `ChainType` is set from `data["team_config"]` (line 122, store.go line 144), which comes from the `session_start` event's `team_config` field. This is typically a chain/workflow name like `"plan-build-review"` from `chains.yaml`. These are **workflow identifiers, not secrets**, but they do reveal internal naming conventions to any authenticated user.

> **Finding P3-INFO-01:** `sessions_by_chain` keys expose internal chain/workflow names. Acceptable for authenticated users, but consider whether all authenticated users should see the full chain taxonomy. Currently there is no role-based access control — any valid token sees all stats.

## 3. Denial of Service — **P2 (Medium)**

**Finding P2-DOS-01: No rate limiting on GET endpoints**

The `rateLimitMiddleware` (line 418) explicitly bypasses all GET/HEAD/OPTIONS:

```go
if r.Method == "GET" || r.Method == "HEAD" || r.Method == "OPTIONS" {
    next.ServeHTTP(w, r)
    return
}
```

The `Stats()` function (store.go lines 240–256) acquires an `RLock` and iterates **all sessions**, performing:
- One map allocation (`make(map[string]int)`)
- N iterations (one per session)
- String comparison + map insertion per iteration

**Impact assessment:**
- The lock is a **read lock** (`RLock`), so concurrent stats calls don't block each other — they only block writes (`Append`, `CloseStale`, etc.)
- Memory allocation is bounded: one `SessionStats` struct + one map entry per distinct chain type
- No unbounded growth or amplification
- However, an unauthenticated attacker **cannot** exploit this (auth required), so the attacker must have a valid token

**Severity justification:** P2 because:
1. Auth-gated reduces exploitability
2. Read-lock contention under aggressive polling could degrade write throughput
3. This applies to **all** GET API endpoints (not just `/stats`), so it's a pre-existing architectural pattern, not a regression from this endpoint

> **Recommendation:** Consider adding a lightweight read rate-limiter for API GET endpoints, or at minimum cache the stats response with a short TTL (e.g., 5–10 seconds) to collapse duplicate requests.

## 4. Injection Vectors — ✅ PASS (No findings)

**Analysis:**
- **No user input:** The handler accepts no query parameters, path parameters, or request body. It's a pure read from in-memory state.
- **JSON serialization safety:** `json.NewEncoder(w).Encode(store.Stats())` uses Go's `encoding/json`, which properly escapes all string values in JSON output. Even if `ChainType` contained malicious characters (e.g., `<script>`, SQL fragments), they would be safely JSON-encoded.
- **No SQL/template/command surfaces:** The handler never touches the database, templates, or OS commands.

**Verdict:** Zero injection surface. Clean.

## 5. CORS — ✅ PASS (No findings)

**Analysis:** The `corsMiddleware` (line 321) applies uniformly to all routes. The `/api/sessions/stats` endpoint inherits the same CORS policy. Notably:

- If `CORS_ORIGINS` env is empty, the middleware reflects the `Origin` header (open CORS). This is a **pre-existing** concern for the entire API, not specific to this endpoint.
- If `CORS_ORIGINS` is set, only whitelisted origins are reflected.

No new CORS exposure from this endpoint.

---

## Summary

| ID | Category | Severity | Description |
|---|---|---|---|
| — | Authentication | ✅ PASS | Correctly requires Bearer token; not on public whitelist; fails closed |
| P3-INFO-01 | Information Disclosure | **P3** | Chain type names exposed in `sessions_by_chain` keys; low risk for authenticated users |
| P2-DOS-01 | Denial of Service | **P2** | No rate limiting on GET endpoints; authenticated attacker could poll aggressively and cause read-lock contention (pre-existing pattern, not a regression) |
| — | Injection | ✅ PASS | Zero injection surface; no user input; safe JSON serialization |
| — | CORS | ✅ PASS | Inherits existing CORS policy; no new exposure |

**Overall verdict: APPROVE.** The endpoint is well-implemented with minimal attack surface. The P2 finding is a pre-existing architectural concern that affects all GET endpoints equally and is mitigated by the authentication requirement. No blocking issues for this change.

