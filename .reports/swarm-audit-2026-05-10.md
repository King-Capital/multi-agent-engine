# Full Codebase Swarm Audit — 2026-05-10

5 reviewers, 1 round. All findings below need fixer passes.

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 6 |
| HIGH | 14 |
| MEDIUM | 16 |
| LOW | 9 |
| INFO | 7 |

## CRITICAL (fix first)

| # | File | Finding | Reviewer |
|---|------|---------|----------|
| C1 | team-execution.ts:432 | Parallel teams mutate shared session.totalCost — lost cost increments | Core, Arch |
| C2 | pi.ts:51 | Negative cost when cacheReadTokens > inputTokens | Adapters |
| C3 | pi.ts:147-168 | Timeout handler never cancels stdout reader — zombie pipe blocks | Adapters |
| C4 | pi.ts:317-349 | exitRace promise created but never awaited — unhandled rejection | Adapters |
| C5 | config.ts:171 | cache.delete() uses relative key but cache stores full path — stale config | Config |
| C6 | orchestrator.ts:283-334 | Raw agent output injected into next step context — prompt injection vector | Security |

## HIGH (fix in same pass)

| # | File | Finding | Reviewer |
|---|------|---------|----------|
| H1 | self-healing.ts + team-execution + orchestrator | Retry amplification: 4×3×2=24 invocations, no aggregate cost check | Arch |
| H2 | orchestrator.ts | No SIGTERM handler — agents orphaned on process kill | Arch |
| H3 | team-execution.ts:146 | Sandbox allocated but never used for execution isolation | Arch |
| H4 | nudge.ts:132 | Non-null assertion `adapter!` crashes when adapter is undefined | Config |
| H5 | perf-log.ts:36-38 | Read-then-write append race — concurrent calls lose records | Config |
| H6 | cli.ts:198 | Help says `--status done` but code expects `completed` | Config |
| H7 | pi.ts:236-246 | Brace mismatch / misleading indentation on cost fallback | Adapters |
| H8 | pi-embedded.ts:185 | Busy-wait spin loop with no timeout | Adapters |
| H9 | pi-embedded.ts:207 | session.dispose() not called on error path — resource leak | Adapters |
| H10 | a2a.ts:374 | Timeout cleared on headers, body read has no protection | Adapters |
| H11 | self-healing.ts:63 | Mutates caller's opts object (side effect) | Core |
| H12 | orchestrator.ts:337-358 | Parallel step failures never retried (dead path) | Core |
| H13 | orchestrator.ts:596 | User-controlled regex in verifyTillDone — ReDoS risk | Core |
| H14 | security.ts:57-74 | Advisory-only checks are dead code — never wired into adapters | Security |

## MEDIUM (fix in round 2)

| # | File | Finding |
|---|------|---------|
| M1 | event-emitter.ts:41 | dashboardDown flag permanent — no recovery if dashboard restarts |
| M2 | event-emitter.ts:71 | Buffer grows unbounded if dashboard is slow |
| M3 | messaging.ts:62 | SSE reconnect has no backoff — thousands of failed connections |
| M4 | monitoring.ts:53-77 | startMonitor/stopMonitor dead exports — replaced by ActiveMonitor |
| M5 | active-monitor.ts:112 | executeNudge fire-and-forget — webSearchNudge has no timeout |
| M6 | config-cli.ts:231 | parseFloat accepts NaN — silently writes invalid budget to config |
| M7 | pi.ts:425 | Empty string model falls through `??` — should use `||` |
| M8 | a2a.ts:457 | response.body! non-null assertion could throw |
| M9 | a2a.ts:361 | Streaming method name may not match A2A spec |
| M10 | security.ts:249 | matchGlob path traversal bypass — `../` stripping insufficient |
| M11 | sandbox-pool.ts:114 | Proxmox API call has no TLS enforcement |
| M12 | sandbox-pool.ts:28 | Subnet/offset from env without validation |
| M13 | orchestrator.ts:474 | Agent-reported costs trusted without verification |
| M14 | pipeline-state.ts:55 | sessionId not validated in resume() — path traversal possible |
| M15 | team-execution.ts:276-290 | Silent merge conflict loss — worker changes dropped |
| M16 | severity-scanner.ts | Scanner gameable — false-positive DoS or false-negative evasion |

## Fixer Strategy

### Pass 1: CRITICAL + HIGH safety (separate PR)
- C1: Sequential cost accumulation after allSettled in runParallelStep
- C2: `Math.max(0, inputTokens - cacheReadTokens)`
- C3: Cancel reader + close stdin in timeout handler
- C4: Add `.catch()` to exitRace promise
- C5: Fix cache key to use full resolved path
- C6: Wrap inter-step output in XML tags + apply sanitizeAgentInput
- H1: Add aggregate cost guard spanning heal × retry × feedback
- H4: Guard `adapter!` with null check fallback
- H5: Use appendFileSync for perf log
- H11: Spread opts instead of mutating

### Pass 2: HIGH reliability
- H2: Add SIGTERM/SIGINT handler with graceful shutdown
- H6: Accept "done" as alias for "completed"
- H7-H10: Pi/A2A adapter fixes
- H12-H13: Parallel retry + ReDoS protection

### Pass 3: MEDIUM hardening
- M1-M3: Event emitter resilience
- M4-M5: Monitoring cleanup
- M10-M14: Security hardening
