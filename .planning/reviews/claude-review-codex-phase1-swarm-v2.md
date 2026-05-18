# Claude Review of Codex's Phase 1 Implementation

Branch: `fix/phase1-lead-only-cert`
Worktree: `/Volumes/ThunderBolt/Development/ai-agents/platforms/codex-phase1-lead-only-cert`
Reviewed: 2026-05-18
Status: Not committed. Full live Pi run did not pass before Codex was stopped.

## Overall: STRONG implementation — not finished but high quality

Codex's code is the most thorough of the three agents on the harness and test side. It independently reached the same engine-level fixes as Pi and Claude, and added two unique gates (worker-spawn rejection, non-synthesis contract leak detection) that neither other agent implemented. The gap is only in live Pi completion — Codex was stopped before the full 3-fixture run passed.

## Convergence (identical decisions across all three agents)

| Area | Match |
|------|-------|
| Chain-runner cert mode: skip retry loop | exact — all three identical |
| Chain-runner cert mode: degraded step status | exact — all three identical |
| Lead-only via env var + step config | exact — all three identical |
| `lead_only` in types.ts | exact — all three identical |
| Canonical artifact prefers CERTIFICATION_CONTRACT | exact — all three identical |
| Operational vs substantive failure separation | exact — all three identical |
| Lead completion check (5 leads required) | exact — all three identical |
| Pi adapter `resultFromFinalText` refactor | exact — Codex and Pi identical |
| Pi adapter reverse text block search | exact — Codex and Pi identical |
| Synthesis prompt with inline CERTIFICATION_CONTRACT template | exact — Codex and Pi identical |
| Echo adapter CERTIFICATION_CONTRACT addition | exact — Codex and Pi identical |

## Where Codex did better than both Pi and Claude

### 1. Worker-spawn rejection gate (unique to Codex)

`require_trace_health` includes a `worker_spawn_count` check that explicitly fails if ANY non-lead, non-synth, non-orchestrator agent.start event appears in the trace. This enforces the Phase 1 lead-only invariant at the harness level, not just the engine level. Neither Pi nor Claude check for this — their harnesses would silently pass if a bug caused workers to spawn.

### 2. Non-synthesis CERTIFICATION_CONTRACT leak gate (unique to Codex)

`non_synthesis_contract_artifacts()` function scans all non-synthesis agent artifacts for `CERTIFICATION_CONTRACT:` content. If a review lead or worker emits a contract (which should be synthesis-only per #326), the harness fails. This directly addresses issue #326. Neither Pi nor Claude have this check.

### 3. Lead prompt explicitly blocks CERTIFICATION_CONTRACT emission

In lead-only mode, Codex adds: "If the task mentions CERTIFICATION_CONTRACT, do not emit it. CERTIFICATION_CONTRACT is synthesis-only." This prevents leads from emitting contracts that could confuse the canonical artifact selection. Pi and Claude don't have this prompt-level guard.

### 4. `PreparedTeamStep.leadOnly` as explicit typed state

Codex adds `leadOnly: boolean` to the `PreparedTeamStep` interface and checks `prepared.leadOnly` in `delegateToLead` instead of Pi's approach of string-matching "LEAD-ONLY MODE:" in the prompt. This is more robust — the lead-only decision is structural, not dependent on prompt text.

### 5. Most comprehensive tests

- 34 harness regression tests (vs Pi's 29, Claude's 29)
- Added a dedicated `delegateToLead` test for explicit lead-only returning earlyReturn without relying on prompt text
- All existing `delegateToLead` tests updated with `leadOnly: false` to preserve type safety
- 333-line test file (vs Pi's 271, Claude's ~285)

### 6. `marks_certification_ready` parser improvement

Codex's parser adds `certification[[:space:]_]+ready[[:space:]]*:[[:space:]]*false` and `certification_ready:[[:space:]]*false` to the negation patterns. This means `certification_ready: false` in a contract block won't false-positive as "certification ready." Pi and Claude's parsers handle this less precisely.

### 7. Adaptive timeout default

Codex uses `default_timeout="60"` for echo and `default_timeout="150"` for Pi, with `MAE_CERT_TIMEOUT` override. Pi hardcodes 180s. Claude uses 60s for both (which caused issues with Pi runs that needed more time). Codex's approach is the most practical.

## Same bug as Pi: pipefail in `unsuperseded_empty_output_artifacts`

Line ~159 in Codex's harness has the same `grep -q && printf` pattern that silently kills the script via `set -euo pipefail`. However, Codex partially mitigates this by wrapping calls in subshells:

```bash
empty_output_count="$({ unsuperseded_empty_output_artifacts "$trace_file" || true; } | wc -l | tr -d ' ')"
```

The `|| true` prevents the pipefail from propagating. So Codex's harness actually works correctly despite the internal bug — the `|| true` wrapper catches it. This is better than Pi's version (which doesn't have the wrapper and will fail), but the underlying `grep -q && printf` should still be fixed for clarity.

## The incomplete piece

Full live Pi run across all 3 fixtures did not finish before Codex was stopped. The failing-only fixture passed, so the remaining issue is in clean or seeded fixtures during the full run. Codex was actively debugging this when stopped. This is the only gap versus Pi and Claude (both of which completed the full 3-fixture run).

## Interesting differences from Pi

| Area | Pi | Codex |
|------|-----|-------|
| Lead-only early return check | `leadOpts.userPrompt.includes("LEAD-ONLY MODE:")` | `prepared.leadOnly` (typed boolean) |
| Worker spawn enforcement | Not checked in harness | Explicit `worker_spawn_count == 0` gate |
| Contract leak detection | Not checked | `non_synthesis_contract_artifacts()` gate |
| Lead CERTIFICATION_CONTRACT blocking | Not in prompt | Explicit prompt instruction |
| Timeout default | 180s fixed | 60s echo / 150s Pi adaptive |
| Harness test count | 29 | 34 |
| pipefail mitigation | None (bug will fire) | `|| true` wrapper (works despite bug) |

## Files reviewed

- `engine/chain-runner.ts` — cert mode changes (identical to Pi)
- `engine/team-execution.ts` — lead-only with `PreparedTeamStep.leadOnly` + synthesis prompt template
- `engine/team-execution.test.ts` — 4 new tests including explicit lead-only earlyReturn
- `engine/types.ts` — `lead_only` additions (identical to Pi)
- `engine/adapters/pi.ts` — `resultFromFinalText` + reverse text block (identical to Pi)
- `engine/adapters/echo.ts` — CERTIFICATION_CONTRACT addition (identical to Pi)
- `agents/teams/chains.yaml` — lead_only + read_only additions
- `scripts/certify-live-swarm` — full harness with worker-spawn and contract-leak gates
- `scripts/certify-live-swarm-test` — 34 regression fixtures (333 lines)
- `docs/commands.md`, `docs/concepts.md` — lead-only docs
- `justfile` — cert-test and cert-live targets

## Recommendation

Codex has the strongest harness and test coverage of the three agents. If merging Pi as the base (per Pi review recommendation), cherry-pick from Codex:

1. **Worker-spawn rejection gate** — `worker_spawn_count == 0` check in `require_trace_health`
2. **Non-synthesis contract leak gate** — `non_synthesis_contract_artifacts()` function and check
3. **`PreparedTeamStep.leadOnly` typed boolean** — replace Pi's prompt-string-matching approach
4. **Lead prompt CERTIFICATION_CONTRACT blocking** — "do not emit it" instruction
5. **Adaptive timeout** — 60s echo / 150s Pi defaults
6. **`marks_certification_ready` parser improvement** — `certification_ready: false` negation pattern
7. **Extra `delegateToLead` test** for explicit lead-only mode
