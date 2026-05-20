# Phase 5 Cross-Worktree Assessment

**Assessor:** pi-opus (claude-opus-4-6@default)
**Date:** 2026-05-19
**Scope:** Standard Swarm v2 Phase 5 — Web/CLI steer as high-authority participants

---

## Summary Table

| Dimension | **pi-opus** | **codex** | **claude** | **pi-gpt55** |
|-----------|------------|-----------|------------|-------------|
| **Tests** | 643 pass, 0 fail ✅ | 631 pass, 0 fail ✅ | 384 pass, 25 fail ⚠️ | 632 pass, 0 fail ✅ |
| **Typecheck** | Clean ✅ | Clean ✅ | Clean ✅ | Clean ✅ |
| **Cert harness** | 40/40 ✅ | 40/40 ✅ | 40/40 ✅ | 40/40 ✅ |
| **New tests** | 14 | 2 | 19 (own module) | 3 |
| **Committed** | Yes (3 commits) | No | No | No |
| **Lines changed** | +703/−17 | +249/−18 | +361/−24 | +281/−29 |
| **Files** | 13 | 11 | 7 (+2 new) | 13 |

---

## 1. codex-phase5 — Solid, Minimal

**Approach:** Adds `SteerParticipantKind`, `SteerAction`, `SteerCertificationImpact` types. Uses a single reusable participant ID per source kind (`"web-steer"` or `"cli-steer"`) rather than unique-per-interaction IDs. Exports `STEER_AUTHORITY = 90` constant. Adds trace recorder support for `steer.action`.

### Strengths

- Clean and minimal implementation — smallest diff (249 lines)
- Trace recorder gets proper `steer.action` field extraction (unique among all 4)
- Good `isSteerEvent()` that also catches participant start events with steer kind
- Validator checks authority (must be 90) and missing cert impact — goes beyond basic pass/fail
- Integration tests updated with new steer assertions (`steer:web-steer:pause`)
- Uses `allowSteerEvents` context flag — clear naming

### Weaknesses

- Only 2 new validator tests — very light test coverage for a Phase 5 implementation
- No event-emitter tests for `steerAction`
- Reuses same participant ID for all steer events from same source (`"web-steer"`) — could confuse dashboard pool view in Phase 6 if two web steer actions overlap
- **Missing `participantEnd`** — steer participant starts but never ends. The `steerAction()` emits `participantStart` + `participantActivity` but no `participantEnd`. This is a **bug**: steer participants will appear permanently active/stale in the dashboard agent pool
- No new steering test file — classification/inference tests missing

### Verdict

Clean minimal approach with a critical missing `participantEnd` bug and thin test coverage.

---

## 2. claude-phase5 — Most Architecturally Ambitious

**Approach:** Creates a full `SteerParticipant` class in a new `engine/steer-participant.ts` module with its own test file. Long-lived participants per source with `ensureRegistered()` pattern — one `web-steer` and one `cli-steer` participant per session that persist across interactions. 19 dedicated tests. Changes event types from `pause`/`resume` to `steer_pause`/`steer_resume`.

### Strengths

- Richest design: dedicated `SteerParticipant` class with `handleSteer()`, `endAll()`, `getSteerEvents()`, `setCertificationMode()`
- 19 targeted tests in own module — best test coverage of steer-specific behavior
- Validator does deeper analysis: checks if steer stop prevented leads from completing (evidence-hiding detection)
- Long-lived participants properly end at session cleanup (`endAll()` in both `run()` and `shutdown()`)
- `CertificationMode` type with proper interactive vs unattended semantics
- Decision log entry included

### Weaknesses

- **25 test failures** — 24 pre-existing delegation enforcement failures + 1 new integration test failure (changed `"pause"` event type to `"steer_pause"` without updating test assertion)
- **Breaking change:** event types `pause` → `steer_pause`, `resume` → `steer_resume`, `session_end` → `steer_stop` — this changes the dashboard event type names that the Go store switches on, which would **break dashboard session status tracking** (the Go store only handles `EventPause`, `EventResume`, not `steer_pause` etc.)
- `steer.command` trace type doesn't match the `steer.action` convention used by the other 3 implementations
- No `steer_action` event emission from `steerAction()` — relies on the orchestrator emitting events directly, creating split responsibility
- Missing trace-schema.md update
- Missing event-emitter tests
- No CLI `--unattended` flag
- `types.ts` defines `CertificationMode` type, but validator also redefines it — duplication

### Verdict

Most sophisticated design with the best validator (evidence-hiding detection), but has breaking compatibility issues with the dashboard event store and 1 new test failure. The `SteerParticipant` class is good design material for later, but the event type renames are a no-ship blocker.

---

## 3. pi-gpt55-phase5 — Pragmatic, Dashboard-First

**Approach:** Adds `steer_source` field to the dashboard Go models and SSE pipeline. Modifies `messaging.ts` to pass source through the SSE listener. Uses `typeof this.emitter.steerAction === "function"` guard for backward compatibility. No new types in `types.ts` — uses inline types.

### Strengths

- **Only implementation that updates the dashboard Go backend** — adds `SteerSource` field to `EventData`, `handleUserMessage`, and JSON deserialization
- **Only implementation that modifies `messaging.ts`** to pass `steer_source` through the SSE pipeline from dashboard → engine
- Pragmatic backward-compat guard (`typeof this.emitter.steerAction`)
- Clean event-emitter implementation with transient participant lifecycle
- Trace recorder updated with `steer.action` support
- Decision log and progress updates included

### Weaknesses

- Only 3 new tests (1 event-emitter, 2 validator) — very thin coverage
- `sendUserMessage` API change adds `source` parameter — changes the public method signature
- No standalone steer types — everything is inline `"web" | "cli"` strings
- Participant ID is `${kind}-${sessionId}` — all steer events from same source share one ID, same concern as codex
- The `typeof` guard in orchestrator is defensive but suggests the implementation isn't confident in its own type system
- `steer_source` in dashboard SSE relies on the frontend sending it — current web dashboard doesn't send this field, so web messages would need client-side changes

### Verdict

Most end-to-end implementation (engine + dashboard + messaging), but thin test coverage and introduces a dependency on dashboard client changes that don't exist yet.

---

## 4. pi-opus-phase5 (self-assessment)

**Approach:** Adds `SteerSource`, `SteerIntent`, `SteerEventData` types. Transient participant bracket per steer interaction with counter-based unique IDs (`web-steer-1`, `web-steer-2`, …). Source inferred from `messageId` prefix (`tui-*` = CLI). Every steer gets a `participant_start` → `steer_action` → `participant_end` lifecycle.

### Strengths

- Most tests (14 new) — 8 validator, 4 emitter, 2 classification
- Zero test failures
- Committed (3 clean commits with decision log)
- Unique participant IDs per interaction — no collision risk for Phase 6 dashboard
- Comprehensive trace-schema.md section with event shapes, fields, and certification semantics
- `--unattended` CLI flag for `mae validate-cert`
- Dashboard Go model updated with `EventSteerAction` constant
- Source inference is zero-config — no API changes needed, just reads messageId prefix

### Weaknesses

- No trace recorder `steer.action` field extraction (codex has this)
- No evidence-hiding detection in interactive mode (claude has this)
- No messaging.ts changes — source inference is heuristic-based rather than explicit
- `certification_impact` is a string union rather than a typed constant
- `STEER_AUTHORITY` is inline `90` rather than a named constant

---

## Recommended Consolidation Path

**Base: pi-opus** — committed, most tests (14), clean lifecycle (transient bracket), zero test failures, unique participant IDs per interaction, comprehensive trace-schema docs, decision log.

### Cherry-pick from codex

- Trace recorder `steer.action` field extraction (unique contribution, not in pi-opus)
- `STEER_AUTHORITY` exported constant (cleaner than inline 90)
- Authority and cert-impact validation in the validator check

### Cherry-pick from claude

- Evidence-hiding detection in interactive mode (steer stop preventing lead completion) — unique and valuable validator logic
- `SteerParticipant.endAll()` cleanup pattern concept for session shutdown (defensive)

### Cherry-pick from pi-gpt55

- Dashboard Go `SteerSource` field in `EventData` — only implementation that makes dashboard user-message handler steer-aware
- Trace recorder `steer.action` support (same as codex)

### Do NOT take from claude

- The `steer_pause`/`steer_resume`/`steer_stop` event type renames — they break the Go dashboard event store switch which only handles the original `EventPause`, `EventResume` constants
- The `steer.command` trace type — inconsistent with the other 3 implementations' `steer.action`

### Do NOT take from pi-gpt55

- The `messaging.ts` signature change to pass `source` — adds complexity to the SSE callback pipeline and relies on dashboard client changes that don't exist
- The `typeof this.emitter.steerAction === "function"` guard — unnecessary if the type system is correct
