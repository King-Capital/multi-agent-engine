# Builder - Attempt 1
Grade: unknown
Cost: $0.0000
Tokens: 18527

## Output

Route ordering is correct — `/sessions/stats` is registered before `/sessions/{sessionID}`, so chi will match the literal path first.

Here's a summary of the changes:

**1. `dashboard/internal/events/store.go`** — Added `Stats()` method:
- Returns `map[string]interface{}` with `total_sessions`, `total_cost`, `total_tokens`, `sessions_by_chain`
- Uses read lock (`RLock`) for thread safety
- Groups sessions by `ChainType` (falls back to `"unknown"` if empty)

**2. `dashboard/handlers_session.go`** — Added `handleSessionStats` handler after `handleListSessions`:
- Same style as `handleListSessions` — sets `Content-Type: application/json`, encodes `store.Stats()`

**3. `dashboard/main.go`** — Wired up the route:
- `GET /api/sessions/stats` → `handleSessionStats`
- Placed before `/sessions/{sessionID}` to avoid chi matching `stats` as a session ID

